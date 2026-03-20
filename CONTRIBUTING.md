# Contributing to Glubean for VS Code

## Development

```bash
npm install
npm run watch    # esbuild watch mode

# Then press F5 in VS Code to launch Extension Development Host
```

## Building

```bash
npm run build:extension   # production build (extension)
npm run build:webview     # production build (webview)
npm run package           # create .vsix
```

## Project Structure

```
src/
├── extension.ts              # Entry point — setup, commands, env switcher
├── testController.ts         # Test Controller — discovery, execution, debug
├── testController/           # Focused modules: executor, artifacts, debug, results
├── taskPanel/                # Tasks Panel provider, runner, parser, storage
├── webview/                  # Preact components for result viewer
├── codeLensProvider.ts       # CodeLens for test.pick example buttons
├── resultCodeLensProvider.ts # CodeLens "Result (N)" on test definitions
├── resultViewerProvider.ts   # Result viewer (CodeMirror 6)
├── resultNavigator.ts        # Result history navigation (prev/next, status bar)
├── hoverProvider.ts          # Hover preview for vars.require() / secrets.require()
├── envLoader.ts              # .env / .secrets file loader
├── parser.ts                 # Static regex parser — extracts test metadata
├── diagnose.ts               # Glubean: Diagnose command
└── telemetry.ts              # Opt-in anonymous telemetry (PostHog)
docs/
└── telemetry.md              # Full telemetry transparency document
```

## Testing

See [TESTING.md](TESTING.md) for the testing strategy and how to run tests.

```bash
npx tsx --test src/**/*.test.ts
```
