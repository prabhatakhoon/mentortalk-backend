# mentortalk-backend

Serverless Node.js Lambdas for the MentorTalk platform — auth, sessions, mentor/mentee profiles, wallets, payouts, support, and WebSocket handlers. Deployed to AWS Lambda behind API Gateway in `ap-south-1`.

## Documentation

All project docs live in [mentortalk-docs](https://github.com/prabhatakhoon/mentortalk-docs) — schema, architecture, policies, decisions, sprint plans.

Common references:
- [Database schema](https://github.com/prabhatakhoon/mentortalk-docs/blob/main/schema/schema.md)
- [Backend architecture](https://github.com/prabhatakhoon/mentortalk-docs/blob/main/mentortalk-backend-architecture.md)
- [Accounting & financial flows](https://github.com/prabhatakhoon/mentortalk-docs/blob/main/mentortalk_accounting.md)

This README only covers what's specific to running and developing this codebase.

## Setup

Clone this repo and the docs repo side-by-side:

```bash
git clone https://github.com/prabhatakhoon/mentortalk-backend.git
git clone https://github.com/prabhatakhoon/mentortalk-docs.git
```

Each Lambda is a self-contained npm package under its own folder (`mentortalk-mentor/`, `mentortalk-session/`, etc.). Install dependencies inside the folder you're working on:

```bash
cd mentortalk-mentor
npm install
```

AWS credentials configured for `ap-south-1` are required to deploy.

## Deploy

`update.ps1` zips a single Lambda's folder, commits + pushes, uploads via `aws lambda update-function-code`, and tags the deploy:

```powershell
.\update.ps1 mentortalk-mentor "fix payouts bank validation"
```

## Layout

Each top-level folder (e.g. `mentortalk-mentor`) is one deployable Lambda. They share no code — `fcmHelper.js` and similar helpers are physically copy-pasted across Lambdas.
