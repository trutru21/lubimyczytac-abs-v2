//  v10
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const stringSimilarity = require("string-similarity");
const NodeCache = require("node-cache");
const http = require("http");
const https = require("https");

const app = express();
const port = process.env.PORT || 3000;

/* CACHE */
const searchCache = new NodeCache({ stdTTL: 600 });
const detailsCache = new NodeCache({ stdTTL: 86400 });

/* HTTP TUNING */
const agentOptions = {
    keepAlive: true,
    maxSockets: 5,
    maxFreeSockets: 5,
    timeout: 6000,
    freeSocketTimeout: 4000
};
const agent = new http.Agent(agentOptions);
const secureAgent = new https.Agent(agentOptions);

axios.defaults.httpAgent = agent;
axios.defaults.httpsAgent = secureAgent;

axios.defaults.headers.common["User-Agent"] =
"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36";
axios.defaults.headers.common["Accept-Language"] = "pl-PL,pl;q=0.9";
axios.defaults.headers.common["Connection"] = "keep-alive";

/* HELPERS */

const adaptiveDelay = (ms, signal) => {
    return new Promise((resolve) => {
        const timeoutId = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timeoutId);
                // Graceful exit zamiast rzucania wyjątku
                resolve();
            }, { once: true });
        }
    });
};

const normalize = (s = "") =>
s.toLowerCase().replace(/\s+/g, " ").trim();

/* EXPRESS */

app.use(cors());

app.use((req, res, next) => {
    const apiKey = req.headers["authorization"];
    if (!apiKey) return res.status(401).json({ error: "Unauthorized" });
    next();
});

/* PROVIDER */

class LubimyCzytacProvider {
    constructor() {
        this.baseUrl = "https://lubimyczytac.pl";
    }

    decodeText(buffer) {
        if (!buffer) return "";
        return buffer.toString("utf8");
    }

    decodeUnicode(str) {
        return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
        );
    }

    async searchBooks(query, author = "", budget, signal) {
        const timeLeft = () => Math.max(0, budget.deadline - Date.now());
        const isExpired = () => Date.now() >= budget.deadline;

        /* CLEAN INPUT */
        query = (query || "").slice(0, 200);
        author = (author || "").slice(0, 100).replace(/\./g, " ").trim();

        let cleanedTitle = query;
        const sepIdx = query.indexOf(" - ");

        if (sepIdx !== -1 && sepIdx < 80) {

            const prefix = query.slice(0, sepIdx).trim();
            const rest = query.slice(sepIdx + 3);
            if (!author) {
                author = prefix.replace(/\./g, " ").trim();
            }

            cleanedTitle = rest;
        }

        /* CLEAN TITLE */

        if (!/^".*"$/.test(cleanedTitle)) {
            cleanedTitle = cleanedTitle
            .replace(/(\d+kbps)/gi, "")
            .replace(/\bVBR\b.*$/gi, "")
            .replace(/\[.*?\]/g, "")
            .replace(/czyt.*/gi, "")
            .replace(/superprodukcja/gi, "")
            .replace(/\s-\s/g, "-")
            .replace(/\bT(?:om)?[\s.]?\d{1,3}\b/gi, "")
            .replace(/\(\d{1,3}\)/g, "")
            .replace(/\(.*?\)/g, "")
            .replace(/[^\p{L}\d\-]/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
        }
        else {
            cleanedTitle = cleanedTitle.replace(/^"(.*)"$/, "$1");
        }

        const cacheKey = `${normalize(cleanedTitle)}|${normalize(author)}`;
        const cached = searchCache.get(cacheKey);
        if (cached) {
            console.log(`[Cache] Znaleziono w searchCache dla: "${cleanedTitle}"`);
            return cached;
        }

        console.log(`[Search] Pobieranie list dla: "${cleanedTitle}"...`);

        const booksUrl = `${this.baseUrl}/szukaj/ksiazki?phrase=${encodeURIComponent(cleanedTitle)}${author ? `&author=${encodeURIComponent(author)}` : ""}`;
        const audiobooksUrl = `${this.baseUrl}/szukaj/audiobooki?phrase=${encodeURIComponent(cleanedTitle)}${author ? `&author=${encodeURIComponent(author)}` : ""}`;

        /* FETCH & PARSE WORKER */
        const fetchAndParse = async (url, type) => {
            if (isExpired()) return [];
            try {
                const res = await axios.get(url, {
                    responseType: "arraybuffer",
                    timeout: Math.min(5500, timeLeft()),
                    maxContentLength: 1500000,
                    maxBodyLength: 1500000,
                    signal
                });

                const finalUrl = res.request?.res?.responseUrl || url;

                // 6. Cross-domain redirect protection
                if (!finalUrl.includes('lubimyczytac.pl') && !finalUrl.startsWith(this.baseUrl)) {
                    console.warn(`[Fetch Warn] Zignorowano przekierowanie poza domenę docelową: ${finalUrl}`);
                    return [];
                }

                // 3. Decode Text
                const html = typeof this.decodeText === 'function' ? this.decodeText(res.data) : res.data.toString("utf8");

                // 1. Sanity-check / anty-bot protection
                if (html.includes("challenge-platform") || html.includes("cf-browser-verification")) {
                    throw new Error("Wykryto ścianę antybotową (Cloudflare).");
                }
                if (html.length < 500) {
                    throw new Error("Nie rozpoznano struktury LC (możliwa blokada).");
                }

                const $ = cheerio.load(html);
                const results = [];

                // 4. Perfect Match logic
                if (finalUrl.includes('/ksiazka/')) {
                    console.log(`[Search] Wykryto Perfect Match (${type}): ${finalUrl}`);
                    const title = $('h1.book__title').text().trim();
                    const authorName = $('.book__author-name').first().text().trim() ||
                    $('.authorAllCards__itemText a').first().text().trim() || author;

                    // Wyciągamy ID z finalUrl (np. https://lubimyczytac.pl/ksiazka/123456/tytul)
                    const idMatch = finalUrl.match(/\/ksiazka\/(\d+)/);
                    const bookId = idMatch ? idMatch[1] : undefined;

                    results.push({
                        id: bookId,
                        title: title,
                        authors: [authorName],
                        url: finalUrl,
                        type: type,
                        isPerfectMatch: true
                    });
                }

                else {
                    let items = $('.authorAllCards__item');
                    if (!items.length) {
                        items = $('.authorAllBooks__single');
                    }

                    items.slice(0, 10).each((i, el) => {
                        const titleTag = $(el).find('a.authorAllCards__itemTitle, a.authorAllBooks__singleTextTitle');
                        const title = titleTag.text().trim();
                        const href = titleTag.attr('href');
                        const idMatch = href && href.match(/\/ksiazka\/(\d+)/);
                        const bookId = idMatch ? idMatch[1] : undefined;

                        const bookAuthor = $(el).find('.authorAllCards__itemText a, .authorAllBooks__singleTextAuthor a')
                        .not('.authorAllCards__itemTitle, .authorAllBooks__singleTextTitle')
                        .first().text().trim();

                        if (title && href) {
                            results.push({
                                id: bookId,
                                title: title,
                                authors: bookAuthor ? [bookAuthor] : (author ? [author] : []),
                                         url: href.startsWith('http') ? href : `${this.baseUrl || 'https://lubimyczytac.pl'}${href}`,
                                         type: type,
                                         isPerfectMatch: false
                            });
                        }
                    });
                }
                return results;
            } catch (err) {
                console.warn(`[Fetch Warn] Problem z pobraniem/parsowaniem ${type}: ${err.message}`);
                return [];
            }
        };

        /* CONCURRENT FETCH */
        const [parsedBooks, parsedAudiobooks] = await Promise.all([
            fetchAndParse(booksUrl, "book"),
                                                                  fetchAndParse(audiobooksUrl, "audiobook")
        ]);

        console.log(`[Search] Znalazłem: ${parsedBooks.length} książek, ${parsedAudiobooks.length} audiobooków`);
        const matches = [...parsedBooks, ...parsedAudiobooks];

        /* SCORING & RANKING */
        let ranked = matches
        .map(m => {
            const titleSim = stringSimilarity.compareTwoStrings(normalize(m.title), normalize(cleanedTitle));
            let combinedSim = titleSim;
            let authorSim = 0;

            if (author && m.authors && m.authors.length > 0) {
                authorSim = Math.max(...m.authors.map(a => stringSimilarity.compareTwoStrings(normalize(a), normalize(author))), 0);
                combinedSim = titleSim * 0.6 + authorSim * 0.4;
            }

            if (m.isPerfectMatch) {
                const threshold = 0.35;

                if (combinedSim < threshold) {
                    console.log(`[Score] Odrzucono Perfect Match dla "${m.title}" (Zbyt niskie podobieństwo bazowe: ${combinedSim.toFixed(2)}). Degrada do zwykłego wyniku.`);
                    return { ...m, similarity: combinedSim, isPerfectMatch: false };
                } else {
                    console.log(`[Score] Potwierdzono Perfect Match dla "${m.title}" (Podobieństwo bazowe: ${combinedSim.toFixed(2)}). Wymuszam top ranking.`);
                    return { ...m, similarity: 1.1 };
                }
            }

            return { ...m, similarity: combinedSim };
        })
        .sort((a, b) => {
            if (b.similarity !== a.similarity) return b.similarity - a.similarity;
            const typeValueA = a.type === "audiobook" ? 1 : 0;
            const typeValueB = b.type === "audiobook" ? 1 : 0;
            return typeValueB - typeValueA;
        });

        const maxResults = parseInt(process.env.MAX_RESULTS) || 5;
        ranked = ranked.slice(0, maxResults);

        console.log(`[Rank] Zawężono do top ${maxResults}. Rozpoczynam pobieranie detali...`);
        const enriched = [];

        /*  DEEP DETAILS FETCHING  */
        for (const match of ranked) {
            const remaining = timeLeft();

            if (isExpired()) {
                console.log(`[Skip] Brak budżetu dla "${match.title}" (Timeout). Oddaję wersję podstawową.`);
                enriched.push(match);
                continue;
            }

            const cachedDetails = detailsCache.get(match.url);
            if (cachedDetails) {
                console.log(`[Cache] Detale z cache dla: "${match.title}"`);
                enriched.push(cachedDetails);
                continue;
            }

            if (remaining < 500) {
                console.warn(`[Skip] Zostało tylko ${remaining}ms (Poniżej 500ms). Pomijam szczegóły dla "${match.title}".`);
                enriched.push(match);
                continue;
            }

            const jitter = Math.min(250, Math.max(40, remaining * 0.05));
            await adaptiveDelay(jitter, signal);

            console.log(`[Fetch] Pobieram okładkę/opis dla "${match.title}" (Typ: ${match.type}). Budżet: ${remaining}ms`);
            try {
                const data = await this.getFullMetadata(match, remaining, signal);
                console.log(`[Fetch OK] Pomyślnie pobrano: "${match.title}"`);
                detailsCache.set(match.url, data);
                enriched.push(data);
            } catch (err) {
                const isCanceled = err.code === "ERR_CANCELED" || err.name === "AbortError" || axios.isCancel(err);
                console.error(`[Fetch Błąd] "${match.title}" - ${err.message}`);
                if (!isCanceled) detailsCache.set(match.url, match, 3600);
                enriched.push(match);
            }
        }

        /* FINAL PENALTIES */
        console.log(`[Sort] Aplikuję karę za brak ISBN...`);
        const finalAdjustedMatches = enriched.map((match) => {
            let adjustedSimilarity = match.similarity;
            if (!match.identifiers?.isbn || match.identifiers.isbn === "") {
                adjustedSimilarity *= 0.99;
            }
            return { ...match, similarity: adjustedSimilarity };
        }).sort((a, b) => {
            if (b.similarity !== a.similarity) return b.similarity - a.similarity;
            const typeValueA = a.type === "audiobook" ? 1 : 0;
            const typeValueB = b.type === "audiobook" ? 1 : 0;
            return typeValueB - typeValueA;
        });

        const result = { matches: finalAdjustedMatches };

        if (finalAdjustedMatches.length > 0) {
            searchCache.set(cacheKey, result); // Sukces - standardowy zapis (600s z konstruktora)
        } else {
            console.log(`[Cache Warn] Błąd pobierania lub pusty wynik. Aplikuję krótki negative-cache (30s) dla "${cleanedTitle}".`);
            // Negative cache - 30 sekund zapobiega spamowaniu API przy błędach/pustych wynikach
            searchCache.set(cacheKey, result, 30);
        }

        return result; // Koniec funkcji searchBooks
    }

    parseSearchResults(buffer, type) {
        if (!buffer?.length) return [];
        if (buffer.length > 1_350_000) {
            console.warn(`[Sanity Check] Ignored oversized HTML list (${buffer.length} bytes). Possible bot wall.`);
            return [];
        }

        const decodedData = this.decodeText(buffer);
        const $ = cheerio.load(decodedData);
        const matches = [];

        $(".authorAllBooks__single").each((_, el) => {
            const title = $(el).find(".authorAllBooks__singleTextTitle").text().trim();
            const url = $(el).find(".authorAllBooks__singleTextTitle").attr("href");
            const authors = $(el).find('a[href*="/autor/"]').map((i, a) => $(a).text().trim()).get();

            if (title && url) {
                matches.push({
                    id: url.split("/").pop(),
                             title: this.decodeUnicode(title),
                             authors: authors.map(a => this.decodeUnicode(a)),
                             url: `${this.baseUrl}${url}`,
                             type
                });
            }
        });

        return matches;
    }

    async getFullMetadata(match, timeoutMs, signal) {
        const safeTimeout = Math.max(800, Math.min(timeoutMs, 3000));

        const res = await axios.get(match.url, {
            responseType: "arraybuffer",
            timeout: safeTimeout,
            signal
        });

        if (res.data.length > 1_350_000) {
            throw new Error(`Unexpected HTML size (${res.data.length} bytes) - possible bot wall`);
        }

        const decodedData = this.decodeText(res.data);
        if (
            decodedData.includes("cf-browser-verification") ||
            decodedData.includes("challenge-platform") ||
            decodedData.includes("Checking your browser") ||
            decodedData.includes("DDoS protection")
        ) {
            throw new Error("Bot protection page detected");
        }
        const $ = cheerio.load(decodedData);

        const cover = $(".book-cover a").attr("data-cover") || $(".book-cover source").attr("srcset") || $(".book-cover img").attr("src") || $('meta[property="og:image"]').attr("content") || "";

        let description = "";
        const htmlDesc = $(".collapse-content").html();

        if (htmlDesc) {
            description = htmlDesc
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n\n")
            .replace(/<[^>]*>/g, " ")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/\n\s*\n/g, "\n\n")
            .replace(/\.([A-ZĄĆĘŁŃÓŚŹŻ])/g, ". $1")
            .replace(/(?:\s*\d{1,2}\s+\d+\s+ocen)+/g, "")
            .trim();
        }

        if (!description) {
            description = $('meta[property="og:description"]').attr("content") || "";
            if (description.includes("Serwis dla miłośników") || description.includes("wirtualna biblioteczka")) {
                description = "";
            }
        }
        const publisher = $('dt:contains("Wydawnictwo:")').next("dd").find("a").text().trim() || $('dt:contains("Wydawnictwo:")').next("dd").text().trim() || "";
        const publishedDateText = $('dt[title*="Data pierwszego wydania"]').next("dd").text().trim();
        const publishedDate = publishedDateText ? new Date(publishedDateText) : null;
        const ratingRaw = parseFloat($('meta[property="books:rating:value"]').attr("content"));
        const rating = Number.isFinite(ratingRaw) ? ratingRaw / 2 : null;
        const isbn = $('meta[property="books:isbn"]').attr("content") || "";

        const seriesElement = $('span.d-none.d-sm-block.mt-1:contains("Cykl:")').find("a").text().trim();
        const series = seriesElement ? seriesElement.replace(/\s*\(tom \d+.*?\)\s*$/, "").trim() : null;
        const seriesMatch = seriesElement ? seriesElement.match(/\(tom (\d+)/) : null;
        const seriesIndex = seriesMatch ? parseInt(seriesMatch[1]) : null;

        const genreText = $(".book__category.d-sm-block.d-none").text().trim();
        const genres = genreText ? genreText.split(",").map(g => g.trim()) : [];
        const tags = $('a[href*="/ksiazki/t/"]').map((i, el) => $(el).text().trim()).get() || [];
        const languagesRaw = $('dt:contains("Język:")').next("dd").text().trim();
        const languages = languagesRaw
        ? languagesRaw.split(", ").map(lang => {
            const lowerLang = lang.toLowerCase();
            return lowerLang === "polski" ? "pol" : (lowerLang === "angielski" ? "eng" : lang);
        })
        : [];

        return {
            ...match,
            cover,
            description,
            publisher,
            publishedDate,
            rating,
            series,
            seriesIndex,
            genres,
            tags,
            languages,
            identifiers: { isbn, lubimyczytac: match.id }
        };
    }
}

const provider = new LubimyCzytacProvider();

/* ROUTE */

app.get("/search", async (req, res) => {
    const startTimer = Date.now();
    console.log(`\n------------------------------------------------------------------------------------------------`);
    console.log(`Received search request:`, req.query);

    const REQUEST_BUDGET_MS = parseInt(process.env.BUDGET_MS) || 8500;     // Globalny limit czasu wyszukiwania w LC. ABS ma limit 10s, więc nie ustawiać więvcej niż 9000.
    const budget = { deadline: Date.now() + REQUEST_BUDGET_MS, total: REQUEST_BUDGET_MS };

    const controller = new AbortController();
    const killTimer = setTimeout(() => controller.abort(), REQUEST_BUDGET_MS);

    try {
        const { query, author } = req.query;
        if (!query) return res.status(400).json({ error: "Query required" });

        const results = await provider.searchBooks(query, author, budget, controller.signal);

        const formattedResults = {
            matches: results.matches.map((book) => {
                const year = book.publishedDate ? new Date(book.publishedDate).getFullYear() : null;
                return {
                    title: book.title,
                    author: book.authors.join(", "),
                                         publisher: book.publisher || undefined,
                                         publishedYear: year ? year.toString() : undefined,
                                         description: book.description || undefined,
                                         cover: book.cover || undefined,
                                         isbn: book.identifiers?.isbn || (book.similarity >= 0.95 ? "0" : undefined),
                                         genres: book.genres || undefined,
                                         tags: book.tags || undefined,
                                         series: book.series ? [{ series: book.series, sequence: book.seriesIndex ? book.seriesIndex.toString() : undefined }] : undefined,
                                         language: book.languages && book.languages.length > 0 ? book.languages[0] : undefined,
                                         type: book.type,
                                         similarity: book.similarity,
                };
            }),
        };

        const duration = Date.now() - startTimer;
        console.log(`[DONE] Zakończono w ${duration}ms. Odsyłam pełnego JSONa.`);
        // console.log(JSON.stringify(formattedResults, null, 2)); // odkomentuj, jeśli chcesz zobaczyć wyniki szukania w logach

        res.json(formattedResults);
    } catch (e) {
        if (e.code === "ERR_CANCELED" || e.name === "AbortError" || axios.isCancel(e)) {
            const duration = Date.now() - startTimer;
            console.warn(`[TIMEOUT] Aborted after ${duration}ms (global budget exceeded)`);
            return res.json({ matches: [] });
        }
        console.error(`[FATAL ERROR]`, e);
        res.status(500).json({ error: "Internal error" });
    } finally {
        clearTimeout(killTimer);
    }
});

app.listen(port, () => {
    console.log(`LubimyCzytac V2 provider listening on port ${port}`);
});
