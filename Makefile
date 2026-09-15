# llm-cockpit — every toolchain step runs inside a container; the host stays clean.
# node_modules lives in the named docker volume `cockpit_mod`; build output in
# `cockpit_dist`. `make binary` exports to ../llm-cockpit-out. Nothing lands in
# the repo working tree.

IMG    ?= oven/bun:1.4.2
VOLUME ?= cockpit_mod
DISTV  ?= cockpit_dist
IDU    := $(shell id -u)
IDG    := $(shell id -g)
ROOT   := $(abspath .)
OUT    ?= $(ROOT)-dist
RUN    := docker run --rm -v $(ROOT):/work -v $(VOLUME):/work/node_modules -w /work

.PHONY: shell install test typecheck lint run image binary fixup

shell:
	$(RUN) -it --network host $(IMG) bash

install:
	$(RUN) $(IMG) bun install

test:
	$(RUN) $(IMG) bun test

typecheck:
	$(RUN) $(IMG) bunx tsc --noEmit

lint:
	$(RUN) $(IMG) bunx biome check .

run:
	$(RUN) --network host -v $(DISTV):/work/dist $(IMG) sh -c "bun install && bun run scripts/build.ts && bun run src/server.ts"

image:
	docker build -t llm-cockpit:dev .

binary:
	mkdir -p $(OUT)
	$(RUN) -v $(DISTV):/work/dist -v $(abspath $(OUT)):/out -e PUID=$(IDU) -e PGID=$(IDG) $(IMG) sh -c "bun install && bun run scripts/build.ts && bun build --compile src/server.ts --outfile dist/cockpit && rm -r /out/llm-cockpit /out/web 2>/dev/null; cp dist/cockpit /out/llm-cockpit && cp -r dist/web /out/web && chown -R $(IDU):$(IDG) /out"

# docker creates root-owned mountpoint stubs for the named volumes inside the
# working tree; hand them to the invoking user (run when no container is up)
fixup:
	docker run --rm -e PUID=$(IDU) -e PGID=$(IDG) -v $(ROOT):/work $(IMG) sh -c 'chown $(IDU):$(IDG) /work/dist /work/node_modules 2>/dev/null || true'
