PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
BIN := codex-linux-extension-host

.PHONY: build test install-local install-manifest fmt

build:
	cargo build --release

test:
	cargo test

fmt:
	cargo fmt

install-local: build
	install -d "$(BINDIR)"
	install -m 0755 "target/release/$(BIN)" "$(BINDIR)/$(BIN)"

install-manifest:
	"$(BINDIR)/$(BIN)" install-manifest --host-path "$(BINDIR)/$(BIN)"
