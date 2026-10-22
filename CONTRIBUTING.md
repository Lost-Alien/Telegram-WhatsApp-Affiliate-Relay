# Contributing

Use Node.js 22.13+ and install the locked dependencies with `npm ci`.

```sh
npm run check
npm test
```

The automated suite runs offline with synthetic configuration, temporary SQLite databases and mocked transports. Live account credentials are not needed for normal development. Keep new tests focused on observable behavior: conversion correctness, durable delivery, recovery and resource bounds.

For a change, open a branch, make the smallest useful implementation, add coverage when behavior changes, and describe the result and checks in your pull request. Update the documentation if a configuration variable or operational behavior changes.

Use `.env.example` as the configuration template. Keep actual environment values, account sessions, QR data, message dumps and server-specific scripts out of commits. Report bugs with a minimal reproduction and redacted logs.
