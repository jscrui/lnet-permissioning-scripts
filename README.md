# lnet-permissioning-scripts
Scripts to give/revoke permissions in the LNET blockchain.

## Setup

Install dependencies:
```bash
npm install
```

## Available Scripts

The project includes four permissioning scripts that can be run via npm:

- **Address Permissioning**: `npm run permission:address`
- **Admin Permissioning**: `npm run permission:admin`
- **Target Permissioning**: `npm run permission:target`
- **Nodes Permissioning**: `npm run permission:nodes`

## Dependencies

- **ethers**: ^4.0.49 - Ethereum wallet implementation and utilities

## Project Structure

```
lnet-permissioning-scripts/
├── scripts/
│   ├── permissioning_address.js
│   ├── permissioning_admin.js
│   ├── permissioning_target.js
│   └── permissioning_nodes.js
├── package.json
└── README.md
```
