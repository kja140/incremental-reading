# Incremental Reading Toolkit documentation

The public Docusaurus site for Incremental Reading Toolkit.

```bash
npm install
npm start
```

Production build:

```bash
npm run build
```

The homelab compose service builds this directory and serves `build/` with nginx.

The production hostname is `incremental-reading.kjames.xyz`. Point the existing
Cloudflare Tunnel public hostname at `http://incremental-reading-docs:8080`.
