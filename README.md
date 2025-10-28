# lnet-permissioning-scripts
Utility scripts to manage account, admin, target, and node allowlists on LACNET (multisig-supported).

## 1) Account Permissions

Add or revoke account permissions with membership tiers.

**Actions**
- `add` | `revoke` (default: `add`)

**Membership**
- `basic` | `standard` | `premium`

**Network**
- `mainnet` | `testnet`

**Examples**
```bash
# Add account with premium membership (mainnet)
npm run permission:address -- --action add --address 0x82e58bEd8AEc18E6fe2ceeF0245Dd93ceE9a3d13 --membership premium --network mainnet

# Revoke account permissions (mainnet)
npm run permission:address -- --action revoke --address 0x82e58bEd8AEc18E6fe2ceeF0245Dd93ceE9a3d13 --network mainnet
```

## 2) Admins

Add or remove Admin accounts that can modify permissioning rules (on-chain multisig).

**Actions**
- `add` | `revoke` (default: `add`)

**Network**
- `mainnet` | `testnet`

**Examples**
```bash
# Add an Admin (mainnet)
npm run permission:admin -- --action add --address 0x248906Bf539e8f16FbD14c001f7Bd3D712f95D3E --network mainnet

# Remove an Admin (testnet)
npm run permission:admin -- --action revoke --address 0xa1C93B24a07cf3BEcc74eDD2265B745cF227B7CC --network testnet
```

## 3) Targets

Allow or revoke destination contract addresses enforced by `AccountRules` (multisig).

**Actions**
- `add` | `revoke` (default: `add`)

**Network**
- `mainnet` | `testnet`

**Examples**
```bash
# Add a Target (mainnet)
npm run permission:target -- --action add --address 0xe31CD53b0Cf1f136Fb2272537640223f638206d2 --network mainnet

# Remove a Target (testnet)
npm run permission:target -- --action revoke --address 0x2222222222222222222222222222222222222222 --network testnet
```

## 4) Nodes

Allow or revoke permitted enodes enforced by `NodeRules` (multisig).

**Actions**
- `add` | `revoke` (default: `add`)

**Network**
- `mainnet` | `testnet`

**Examples**
```bash
# Add an enode (mainnet)
npm run permission:nodes -- \
  --network mainnet \
  --action add \
  --enode "enode://<128-hex>@192.0.2.10:30303" \
  --type Validator \
  --name "Node A" \
  --organization "Org A" \
  --geohash 0x00646a6e3431 \
  --did NA \
  --group 0xDAE96FC0046A5AE1864D9A66E6715DA8DA08240E7119816AB722261C0744D8E8

# Remove an enode (testnet)
npm run permission:nodes -- --network testnet --action revoke --enode "enode://<128-hex>@192.0.2.10:30303"
```

**Parameters**
- `--enode` (required) enode URL `enode://<128-hex>@<ipv4>:<port>` (legacy: `--address`)
- `--type` (optional) `Bootnode` | `Validator` | `Writer` | `Observer` | `Other` (default: `Other`)
- `--name`, `--organization`, `--geohash` (6-byte hex), `--did` (default: `NA`), `--group` (bytes32)

> Note: Assumes `NodeIngress` at `0x0000000000000000000000000000000000009999` (as in the provided `genesis.json`).

---

## Configuration

Create `scripts/config.js` with your signer private keys (do not commit real keys).

```javascript
const SIGNER1_PRIVATE_KEY_MAINNET = "0x...";
const SIGNER2_PRIVATE_KEY_MAINNET = "0x...";
const SIGNER1_PRIVATE_KEY_TESTNET = "0x...";
const SIGNER2_PRIVATE_KEY_TESTNET = "0x...";

module.exports = {
  SIGNER1_PRIVATE_KEY_MAINNET,
  SIGNER2_PRIVATE_KEY_MAINNET,
  SIGNER1_PRIVATE_KEY_TESTNET,
  SIGNER2_PRIVATE_KEY_TESTNET
};
```

Notes:
- Scripts import with `require('./config')` from `scripts`, so path must be `scripts/config.js`.
- Ingress/contract addresses and RPC endpoints are hardcoded; update if your network differs.

---

## Security

⚠️ Never commit real private keys. Ensure `scripts/config.js` is ignored by git.