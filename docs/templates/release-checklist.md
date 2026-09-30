# Release checklist: vX.Y.Z

- [ ] All changes in this release are archived (`openspec list` shows none in flight)
- [ ] `scripts/check-change.sh` green on main
- [ ] Changelog written from the archived changes
- [ ] Rollback plan named (previous tag, migration down path if any)
- [ ] Tag pushed; `release` workflow green
- [ ] Attestation verifies: `gh attestation verify <artifact> --repo <owner>/<repo>`
- [ ] Post-release check done (smoke test, error rate, key metric) and noted here
