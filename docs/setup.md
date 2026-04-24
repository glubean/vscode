# Glubean Setup

If automatic setup failed, or you prefer full control over what gets installed
— this guide covers the step-by-step manual setup.

Glubean needs two things to run your API tests:

1. **Node.js** (20+) — the JavaScript runtime. The harness uses [`tsx`](https://www.npmjs.com/package/tsx)
   to execute your `.test.ts` / `.contract.ts` / `.flow.ts` files without a
   separate build step.

2. **`@glubean/cli`** — the test runner behind the ▶ play buttons.
   Installed from npm as a local dev dependency of your project.

---

## Quick install (in an existing project)

```bash
npm install --save-dev @glubean/cli
npx glubean init
```

`glubean init` scaffolds a minimal Glubean project in the current directory
(adds a `glubean.setup.ts`, `.env` / `.env.secrets`, and an example test
under `explore/`). Existing files are preserved unless you pass `--overwrite`.

After it finishes, reopen the folder in VS Code — the extension picks up the
new project automatically.

---

## Manual install

Use this if you want fine-grained control over each step.

### macOS / Linux / Windows

```bash
# 1. Install Node.js 20+
# macOS/Linux: https://nodejs.org/ (or use fnm, nvm, volta, asdf)
# Windows: https://nodejs.org/ (installer) or `winget install OpenJS.NodeJS`
node --version    # should be v20.x or newer

# 2. Inside your project, install Glubean as a dev dependency
npm install --save-dev @glubean/cli @glubean/sdk

# 3. (Optional) scaffold example files
npx glubean init

# 4. Verify
npx glubean --version
```

The extension discovers `@glubean/cli` via your project's `node_modules/`
— no global install needed.

---

## Plugin packages (optional)

If your tests need additional protocols or integrations, install the
relevant plugin(s):

```bash
# GraphQL contract support
npm install --save-dev @glubean/graphql

# gRPC contract support
npm install --save-dev @glubean/grpc

# Browser/OAuth boundary tests
npm install --save-dev @glubean/browser

# Auth helpers (session.ts integrations)
npm install --save-dev @glubean/auth
```

After installing, register the plugin in your `glubean.setup.ts`:

```ts
import { installPlugin } from "@glubean/sdk";
import { graphqlPlugin } from "@glubean/graphql";

installPlugin(graphqlPlugin());
```

The `init` command wires up `glubean.setup.ts` for you.

---

## Is this safe?

- Everything installs into your project's `node_modules/`. No global side
  effects (unless you opt into a global `npm install -g`).
- Glubean source is fully open at
  [github.com/glubean/glubean](https://github.com/glubean/glubean).
- The VS Code extension never downloads or executes anything outside of the
  packages you installed yourself.

## Uninstall

```bash
npm uninstall @glubean/cli @glubean/sdk @glubean/graphql @glubean/grpc
# …and any other @glubean/* packages you added
```

Remove `glubean.setup.ts`, the `tests/` / `explore/` / `contracts/`
folders, and `.env` / `.env.secrets` if you no longer need them.

## Still stuck?

Retry automatic setup from VS Code: `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P`
(Windows/Linux) → **Glubean: Setup**

Or ask in [GitHub Discussions](https://github.com/glubean/vscode/discussions).
