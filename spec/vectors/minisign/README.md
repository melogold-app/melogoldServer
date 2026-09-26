# minisign test vectors

Made with minisign 0.12 and a throwaway key whose secret part was deleted right after signing. They check
`src/modules/maintenance/verify-release.ts` against the real tool; the release key of Melogold is not here.

| File | What |
|---|---|
| `test.pub` | the public key (key id `C6E93FEEDB35F6A3`) |
| `SHA256SUMS`, `SHA256SUMS.minisig` | a prehashed signature (`ED`, BLAKE2b-512), the default of minisign ≥ 0.10 |
| `SHA256SUMS.legacy`, `SHA256SUMS.legacy.minisig` | a legacy signature (`Ed`, `minisign -l`) |

`empty.txt` in `SHA256SUMS` is the hash of an empty file; the `install.sh` line matches no real file.
