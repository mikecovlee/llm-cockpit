# llm-cockpit — every toolchain step runs inside a container; the host stays clean.
# node_modules lives in a named docker volume, never on the host disk.

IMG    ?= oven/bun:1.4.2
VOLUME ?= cockpit_mod
ROOT   := $(abspath .)
RUN    := docker run --rm -v $(ROOT):/work -v $(VOLUME):/work/node_modules -w /work $(IMG)

.PHONY: shell install test typecheck lint run image binary

shell:
	$(RUN) -it --network host bash

install:
	$(RUN) bun install

test:
	$(RUN) bun test

typecheck:
	$(RUN) bunx tsc --noEmit

lint:
	$(RUN) bunx biome check .

run:
	$(RUN) -it --network host sh -c "bun run scripts/build.ts && bun run src/server.ts"

image:
	docker build -t llm-cockpit:dev .

binary:
	$(RUN) sh -c "bun run scripts/build.ts && bun build --compile src/server.ts --outfile dist/cockpit"
