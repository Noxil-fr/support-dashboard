# 🐛 Jira Bug Reporter

Petit outil local pour afficher les bugs Jira de ton équipe.

## Prérequis
- Node.js installé

## Installation

```bash
npm install
```

## Lancement

```bash
node server.js
```

Puis ouvre **http://localhost:3000** dans ton navigateur.

## Utilisation

1. **Domaine** → `tonentreprise.atlassian.net`
2. **Email** → ton email Atlassian
3. **Token API** → génère-le sur https://id.atlassian.com/manage-profile/security/api-tokens
4. **Projet** *(optionnel)* → la clé du projet Jira (ex: `MYAPP`)

## Structure

```
jira-bugs/
├── server.js        ← Serveur proxy Express (évite le CORS)
├── public/
│   └── index.html   ← Interface web
└── package.json
```
"# support-dashboard" 
