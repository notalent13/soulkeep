# Installation

## Fastest Setup (Recommended)

1. Install Node.js 18+
2. Install and configure slskd
3. Clone Soulkeep
4. Run:

```bash
npm install
cp .env.example .env
```

5. Edit only:

```env
SLSKD_API_URL=http://localhost:5030/api/v0
SLSKD_API_KEY=YOUR_SLSKD_API_KEY
```

6. Run:

```bash
node src/download-jspf.mjs
```

That's it.

By default Soulkeep uses:

```text
./downloads
./music
```

You only need to change paths if you use a server or custom folders.
