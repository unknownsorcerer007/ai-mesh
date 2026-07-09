# Contributing to AI Mesh

Thanks for your interest in contributing! 🎉

## Getting Started

```bash
# 1. Fork the repo
# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/ai-mesh.git
cd ai-mesh

# 3. Install dependencies
npm install

# 4. Start NATS relay
curl -sf https://binaries.nats.dev/nats-io/nats-server/v2@latest | sh
./nats-server -js -p 4222 &

# 5. Build and run
npm run build
npm start

# 6. Run tests
npm test
```

## Development

```bash
# Watch mode (auto-rebuild on changes)
npm run dev

# Type check
npx tsc --noEmit

# Lint
npm run lint
```

## Project Structure

```
src/
├── relay/       # NATS relay — message routing core
├── mcp/         # MCP server — AI tool connector
├── auth/        # GitHub OAuth
├── groups/      # Group management
├── messages/    # Message routing via relay
├── security/    # Injection protection, rate limiting
├── tui/         # Terminal chat widget
├── notify/      # Notification system
├── logs/        # Monthly log files
└── types/       # TypeScript types
```

## How to Contribute

### Report Bugs

Open an issue with:
- What you expected
- What actually happened
- Steps to reproduce
- Your environment (OS, Node version)

### Suggest Features

Open an issue with:
- The problem you're trying to solve
- Your proposed solution
- Alternatives considered

### Submit Code

1. Create a branch: `git checkout -b feature/my-feature`
2. Make your changes
3. Add tests if applicable
4. Make sure `npm run build` passes
5. Commit: `git commit -m "feat: add my feature"`
6. Push: `git push origin feature/my-feature`
7. Open a Pull Request

### Commit Convention

We use [Conventional Commits](https://conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation
- `style:` — Formatting (no code change)
- `refactor:` — Code refactor
- `test:` — Adding tests
- `chore:` — Maintenance

## Code Style

- TypeScript strict mode
- No `any` types (use `unknown` if needed)
- Functions should be small and focused
- Comments for "why", not "what"
- Error handling on every external call

## Security

Found a security issue? **DO NOT** open a public issue.

Email: [security contact TBD]

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
