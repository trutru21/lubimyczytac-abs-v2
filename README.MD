# lubimyczytac-abs-v2
Optimized, faster Audiobookshelf Custom Metadata Provider for https://lubimyczytac.pl

Refactored and optimized version of the original `https://github.com/lakafior/lubimyczytac-abs` provider.

## Improvements over the original version (V2):
- **Faster responses:** avoids heavy logging and skips oversized / blocked pages, keeping replies within Audiobookshelf’s 10 s limit.
- **Adaptive Delay System:** Dynamically adjusts request delays based on the remaining time budget to avoid 429/IP bans from Lubimyczytac.pl
- **Configurable** limits – `BUDGET_MS` and `MAX_RESULTS` can be tuned via environment variables.
- **Bot Wall & WAF Protection:** detects Cloudflare or anti-scraping pages and aborts safely.
- **Cleaner Parsing:** extracts readable descriptions without injected site clutter. (`\n\n`).
---

# Instructions

## How to run

### Prerequisites:
Docker and Docker Compose installed on your system.

### Setup and Running:
1. Create a `compose.yml` (or `docker-compose.yml`) file in your desired directory:

```yaml
services:
  lubimyczytac-abs-v2:
    image: ghcr.io/trutru21/lubimyczytac-abs-v2:latest
    container_name: lubimyczytac-abs-v2
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - MAX_RESULTS=5       # Number of results to fetch full details for
      - BUDGET_MS=7500      # Global time budget (Audiobookshelf timeout is 10s)
```
2. Pull the latest Docker image and start the application:
```bash
docker compose up -d
```
## How to use

1. Navigate to your Audiobookshelf settings.
2. Go to Metadata Utils/Custom Metada Providers
3. Click on Add.
4. Name: e.g., LubimyCzytac V2
5. URL: http://your.ip.address:3000 or hostname, e.g., http://lubimyczytac-abs-v2:3000 (without a trailing slash).
6. Authorization Header: any value (cannot be blank), e.g., 00000.
7. Save and test the provider.
