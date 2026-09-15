# Contributing

## Dev loop

Everything runs in containers — the host needs only Docker and `make`:

```bash
make test        # unit tests
make typecheck   # tsc --noEmit
make lint        # biome check
make run         # self-installing dev server → http://<host>:7777
```

Dependencies live in the `cockpit_mod` docker volume and build output in
`cockpit_dist`; the working tree is never written to by any target
(`make binary` exports to `../cockpit-dist`).

## Conventions

- TypeScript strict; Biome owns formatting (`bunx biome check --write .` in the
  container).
- New engines: implement the `EngineAdapter` interface
  (`detect/check/describe/sample`) in `src/adapters/`, register in `index.ts`,
  add fixture-based tests in `test/`.
- Canonical snapshot fields are nullable — never invent defaults for data the
  engine does not report.

## Browser QA (screenshots)

```bash
docker build -t cockpit-qa:local -f Dockerfile.qa .
docker run --rm --network host \
  -e NODE_PATH=/root/.bun/install/global/node_modules \
  -v $PWD:/work cockpit-qa:local bun run /work/scripts/qa-chat.mjs
```

`scripts/qa-image.mjs` additionally verifies the image-attachment flow
(fixture: `screenshots/m2-monitor.png`). Update `screenshots/` in the same PR
when UI visuals change.

## Layout stability

`scripts/qa-stability.mjs` soaks the monitor for ~100 s (tab toggles, resizes,
DPR 1.5) and fails on any height/node drift — run it after CSS/chart
layout changes:

```bash
docker run --rm --network host \
  -e NODE_PATH=/root/.bun/install/global/node_modules \
  -v $PWD:/work cockpit-qa:local bun run /work/scripts/qa-stability.mjs
```

## Submitting

One commit per milestone or fix; `make test typecheck lint` must be green and
`make run` must serve the UI from a fresh clone.
