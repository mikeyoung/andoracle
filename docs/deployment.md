# Deployment & Infrastructure

## Git (GitHub)

- **Remote:** `https://github.com/mikeyoung/andoracle.git` (`origin`)
- **Branch:** `main`
- **Auth:** GitHub token is available in the environment. Push with:
  ```bash
  git push origin main
  ```
  If a prompt appears, use the token as the password (username can be anything).

## FTP / FTPS (mikeyoung.org)

- **Host:** `192.250.231.34`
- **Credentials:** stored in `~/.netrc` (`/home/mike/.netrc`) — login `claudia`, password in the file. Do not print or commit it.
- **Protocol:** explicit FTPS (TLS). The site is served at `https://mikeyoung.org/andoracle/`.
- **Upload order:** assets first, `index.html` last (so visitors never get a new HTML pointing at old/missing assets).
- **Verification:** after upload, byte-verify every artifact with SHA-256 against the local `dist/` files.

### Example deploy with curl

```bash
# Read creds from .netrc
HOST=192.250.231.34
USER=$(awk '/machine 192\.250\.231\.34/{f=1} f&&/login/{print $2}' ~/.netrc)
PASS=$(awk '/machine 192\.250\.231\.34/{f=1} f&&/password/{print $2}' ~/.netrc)

# Upload assets first, HTML last (adjust paths to your dist/)
for f in $(cd dist && find . -type f ! -name 'index.html' | sort); do
  curl --ftp-ssl -u "$USER:$PASS" -T "dist/$f" "ftps://$HOST/andoracle/${f#./}"
done
curl --ftp-ssl -u "$USER:$PASS" -T dist/index.html "ftps://$HOST/andoracle/index.html"
```

## Build & Release

```bash
npm run check          # tests + typecheck + production PWA build
npm run release -- <version>   # bump version (add --no-bridge to retire the update bridge)
git push origin main
# then deploy dist/ via FTPS as above
```
