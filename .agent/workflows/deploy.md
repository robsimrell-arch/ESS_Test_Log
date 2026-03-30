---
description: how to deploy the Chamber Test Log web app to Vercel
---

## Deploy Chamber Test Log Web App

// turbo-all

1. Build the production bundle from the web-app directory:
```
npm run build
```
Run from: `c:\Users\robsi\OneDrive\Documentos\Antigravity\Chamber-Test-Log\web-app`

2. Deploy the built `dist` folder to Vercel production:
```
vercel --prod --yes
```
Run from: `c:\Users\robsi\OneDrive\Documentos\Antigravity\Chamber-Test-Log\web-app\dist`

3. Verify the deployment is live by checking `vercel ls` for the latest production URL.
```
vercel ls 2>&1
```
Run from: `c:\Users\robsi\OneDrive\Documentos\Antigravity\Chamber-Test-Log\web-app\dist`
