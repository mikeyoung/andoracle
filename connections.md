# Connection Notes (for new agents)

**GitHub — via MCP tools**
- GitHub MCP is already configured and authenticated as `mikeyoung`. No setup needed; just call the MCP tools directly (`get_me`, `list_repositories`/`search_repositories`, PR/issue/code-search tools, etc.).

**FTP — via curl + `~/.netrc`**
- Credentials live in `/home/mike/.netrc` (host: `192.250.231.34`). Don't print the file contents; use `--netrc-file`.
- List root:
  ```bash
  curl -sS --netrc-file ~/.netrc ftp://192.250.231.34/
  ```
- Upload a file:
  ```bash
  curl -sS --netrc-file ~/.netrc -T localfile.html ftp://192.250.231.34/path/to/file.html
  ```
- Download a file:
  ```bash
  curl -sS --netrc-file ~/.netrc -o localfile.html ftp://192.250.231.34/path/to/file.html
  ```

**Verified working:** 2026-09-25 (GitHub auth OK; FTP login + root listing OK).

**Onboarding check:** When starting a new session, test both connections and report the results inline in the chat:
1. GitHub — call `get_me` via MCP and confirm it returns the authenticated user.
2. FTP — run `curl -sS --netrc-file ~/.netrc ftp://192.250.231.34/` and confirm a directory listing is returned.
