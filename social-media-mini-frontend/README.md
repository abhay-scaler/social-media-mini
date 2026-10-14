# Frontend — social-media-mini

The React + Vite single-page app. For how it fits into the wider system — Nginx
serving and proxying, the API gateway, and the backend services — see the
[root README](../README.md) and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

## Commands

```bash
npm ci
npm run dev      # Vite dev server; proxies /api to :5000 and /socket.io to :3003
npm run lint
npm run build    # production bundle, served by Nginx in Docker
npm run preview
```

All API calls use relative URLs (`/api/...`, `io({ path: "/socket.io" })`), so
the same build works behind Nginx in Docker and behind the Vite dev proxy. There
is currently no frontend test suite — see
[docs/tests/TEST-PLAN.md](../docs/tests/TEST-PLAN.md) §10 for what to add and
why, and [docs/tests/TEST-STRATEGY.md](../docs/tests/TEST-STRATEGY.md) for the
testing policy.

---

## Vite template notes

This project was scaffolded from the React + Vite template, which provides HMR
and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
