# Release checklist: vX.Y.Z

- [ ] Every factory job in this release is merged through its PR (`factory status` shows none in ship)
- [ ] `scripts/check-change.sh` green on main
- [ ] Changelog written from the merged PRs (their bodies are the jobs' `ship.md`)
- [ ] Rollback plan named (previous tag, migration down path if any)
- [ ] Tag pushed; `release` workflow green
- [ ] Attestation verifies: `gh attestation verify <artifact> --repo <owner>/<repo>`
- [ ] Post-release check done (smoke test, error rate, key metric) and noted here
