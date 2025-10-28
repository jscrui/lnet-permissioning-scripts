const { ethers } = require('ethers');
const {
  SIGNER1_PRIVATE_KEY_MAINNET,
  SIGNER2_PRIVATE_KEY_MAINNET,
  SIGNER1_PRIVATE_KEY_TESTNET,
  SIGNER2_PRIVATE_KEY_TESTNET
} = require('./config');

// =============================================================================
// CONFIGURATION - Network and Contract Settings
// =============================================================================

// Network RPC endpoints
const RPC_URL_MAINNET = "http://34.73.228.200:4545";
const RPC_URL_TESTNET = "http://35.185.112.219:4545";

// Ingress contract addresses for Node permissioning (NodeIngress predeploys in genesis)
const NODE_INGRESS_ADDRESS_MAINNET = "0x0000000000000000000000000000000000009999";
const NODE_INGRESS_ADDRESS_TESTNET = "0x0000000000000000000000000000000000009999"; 

// =============================================================================
// CONSTANTS - Timing and Gas Settings
// =============================================================================

const PROVIDER_TIMEOUT_MS = 10000;           // RPC provider timeout
const TX_CONFIRMATION_TIMEOUT_MS = 30000;    // Timeout for transaction confirmation
const MULTISIG_EXECUTION_TIMEOUT_MS = 120000; // Timeout waiting for multisig execution
const POLLING_INTERVAL_MS = 3000;            // Interval for polling transaction status
const RETRY_DELAY_MS = 10000;                // Delay between retries
const MAX_RETRIES = 3;                       // Maximum number of retry attempts

// Gas limits for different operations
const GAS_LIMIT_ADD_ACCOUNT = 300000;        // Base gas for adding account
const GAS_LIMIT_REMOVE_ACCOUNT = 300000;     // Base gas for removing account
const GAS_LIMIT_CONFIRM = 300000;            // Base gas for confirming transaction
const GAS_BUFFER = 300000;                   // Additional gas buffer for safety

// Function signatures for payload matching (encoded function selectors)
// Multisig stores payloads that call NodeStorage.add/remove
const FUNCTION_SIGNATURES = {
  ADD_NODE_PAYLOAD: ethers.utils.id('add(bytes32,bytes32,bytes16,uint16,uint8,bytes6,string,string,string,bytes32)').slice(0, 10),
  REMOVE_NODE_PAYLOAD: ethers.utils.id('remove(bytes32,bytes32,bytes16,uint16)').slice(0, 10)
};

// =============================================================================
// CONTRACT ABIs
// =============================================================================

// ABI for NodeIngress contract - used to get Node Rules and Admin addresses
const NODE_INGRESS_ABI = [
  'function RULES_CONTRACT() view returns (bytes32)',
  'function ADMIN_CONTRACT() view returns (bytes32)',
  'function getContractAddress(bytes32) view returns (address)'
];

// ABI for Admin contract - only to verify admin permissions
const ADMIN_ABI = [
  'function isAuthorized(address source) view returns (bool)'
];

// ABI for NodeRules - handles node permissioning and multisig
const NODE_RULES_ABI = [
  'function addEnode(bytes32 enodeHigh, bytes32 enodeLow, bytes16 ip, uint16 port, uint8 nodeType, bytes6 geoHash, string name, string organization, string did, bytes32 group) returns (bool)',
  'function removeEnode(bytes32 enodeHigh, bytes32 enodeLow, bytes16 ip, uint16 port) returns (bool)',
  'function getTransactionCount(bool pending,bool executed) view returns (uint256)',
  'function getTransactionIds(uint256 from,uint256 to,bool pending,bool executed) view returns (uint256[])',
  'function getTransactionPayload(uint256 txId) view returns (bytes payload, bool executed)',
  'function confirmTransaction(uint256 txId) returns (bool)',
  'function getConfirmationCount(uint256 txId) view returns (uint256)',
  'function getConfirmations(uint256 txId) view returns (address[])',
  'function getSize() view returns (uint256)',
  'function getByIndex(uint256 index) view returns (bytes32,bytes32,bytes16,uint16,uint8,bytes6,string,string,string,bytes32)'
];

// Minimal interface for decoding NodeStorage payloads in multisig queue
const NODE_STORAGE_ABI = [
  'function add(bytes32,bytes32,bytes16,uint16,uint8,bytes6,string,string,string,bytes32)',
  'function remove(bytes32,bytes32,bytes16,uint16)'
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Parses command-line arguments into a key-value object.
 * Supports both --key value and --key=value formats.
 * 
 * @param {string[]} argv - Process argv array
 * @returns {Object} Parsed arguments as key-value pairs
 * 
 * @example
 * parseArgs(['node', 'script.js', '--address', '0x123', '--network=mainnet'])
 * // Returns: { address: '0x123', network: 'mainnet' }
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    
    const [k, maybeV] = arg.split('=');
    const key = k.replace(/^--/, '');
    
    if (maybeV !== undefined) {
      // Format: --key=value
      out[key] = maybeV;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      // Format: --key value
      out[key] = argv[i + 1];
      i++;
    } else {
      // Format: --key (boolean flag)
      out[key] = true;
    }
  }
  return out;
}

// (No membership concept here)

// =============================================================================
// ENODE HELPERS
// =============================================================================

function hexFromAscii(str, bytesLen) {
  const hex = Buffer.from(str, 'ascii').toString('hex');
  const padded = (hex + '0'.repeat(bytesLen * 2)).slice(0, bytesLen * 2);
  return '0x' + padded;
}

function toHexByte(n) {
  const h = Number(n).toString(16);
  return h.length < 2 ? '0' + h : h;
}

function ipv4ToHex(ipv4) {
  const parts = ipv4.split('.');
  if (parts.length !== 4 || parts.some(p => Number.isNaN(Number(p)) || Number(p) < 0 || Number(p) > 255)) {
    return '';
  }
  return '0x00000000000000000000ffff' + parts.map(toHexByte).join('');
}

function parseEnodeUrl(enodeUrl) {
  // enode://<128-hex>@<ip>:<port>
  if (!enodeUrl || typeof enodeUrl !== 'string' || !enodeUrl.includes('//') || !enodeUrl.includes('@')) {
    return { enodeHigh: '', enodeLow: '', ip: '', port: '' };
  }
  const splitURL = enodeUrl.split('//')[1];
  const [enodeId, rawIpAndPort] = splitURL.split('@');
  if (!enodeId || enodeId.length !== 128 || !/^[0-9a-fA-F]{128}$/.test(enodeId)) {
    return { enodeHigh: '', enodeLow: '', ip: '', port: '' };
  }
  const enodeHigh = '0x' + enodeId.slice(0, 64);
  const enodeLow = '0x' + enodeId.slice(64);
  const [ipAndPort] = (rawIpAndPort || '').split('?');
  const [ipStr, portStr] = (ipAndPort || '').split(':');
  const ip = ipv4ToHex(ipStr || '');
  const port = portStr || '';
  return { enodeHigh, enodeLow, ip, port };
}

function resolveNodeType(value) {
  if (value === undefined || value === null) return 4; // Other
  if (/^\d+$/.test(String(value))) {
    const n = Number(value);
    return n >= 0 && n <= 4 ? n : 4;
  }
  const map = { Bootnode: 0, Boot: 0, Validator: 1, Writer: 2, Observer: 3, Other: 4 };
  return map[String(value)] !== undefined ? map[String(value)] : 4;
}

function defaultGroupForType(nodeTypeNum) {
  switch (nodeTypeNum) {
    case 0: // Bootnode
      return '0x5B950E77941D01CDF246D00B1ECE546BC95234B77D98B44C9187E2733AFA696A';
    case 1: // Validator
      return '0xDAE96FC0046A5AE1864D9A66E6715DA8DA08240E7119816AB722261C0744D8E8';
    case 2: // Writer
      return '0x4BB48E76F19DE6EBED7D59D46800508030AECEA46BA56BD19855D94473E28BC0';
    default:
      return '0x0000000000000000000000000000000000000000000000000000000000000000';
  }
}

/**
 * Validates all required arguments and configurations.
 * Exits the process with error code 1 if validation fails.
 * 
 * @param {Object} args - Parsed command-line arguments
 * @param {Object} config - Network configuration object
 */
function validateInputs(args, config) {
  // Check required arguments
  if (!args.enode && !args.address) {
    console.error('❌ Missing argument --enode');
    process.exit(1);
  }

  if (!args.network) {
    console.error('❌ Missing argument --network');
    process.exit(1);
  }

  // Validate action
  const action = args.action || 'add';
  if (action !== 'add' && action !== 'revoke') {
    console.error('❌ Invalid action. Expected: add or revoke.');
    process.exit(1);
  }

  // Validate enode format
  const { enodeHigh, enodeLow, ip, port } = parseEnodeUrl(args.enode || args.address);
  if (!enodeHigh || !enodeLow || !ip || !port) {
    console.error('❌ Invalid --enode format. Expected: enode://<128-hex>@<ipv4>:<port>');
    process.exit(1);
  }

  // Validate network
  if (!['mainnet', 'testnet'].includes(args.network)) {
    console.error('❌ Invalid network. Expected: mainnet or testnet.');
    process.exit(1);
  }

  // Validate network configuration
  if (!config.rpcUrl || !config.ingressAddress || !config.signer1Key || !config.signer2Key) {
    console.error('❌ Missing hardcoded configuration for selected network.');
    process.exit(1);
  }

  if (action === 'add') {
    // Optional fields handling happens later; basic sanity checks
    if (args.geohash && !/^0x[0-9a-fA-F]{12}$/.test(args.geohash)) {
      console.error('❌ --geohash must be a 6-byte hex (e.g. 0x00646a6e3431)');
      process.exit(1);
    }
    if (args.group && !/^0x[0-9a-fA-F]{64}$/.test(args.group)) {
      console.error('❌ --group must be a bytes32 hex');
      process.exit(1);
    }
  }
}

/**
 * Gets network configuration based on network name.
 * 
 * @param {string} network - Network name ('mainnet' or 'testnet')
 * @returns {Object} Network configuration with RPC URL, addresses, and keys
 */
function getNetworkConfig(network) {
  if (network === 'mainnet') {
    return {
      rpcUrl: RPC_URL_MAINNET,
      ingressAddress: NODE_INGRESS_ADDRESS_MAINNET,
      signer1Key: SIGNER1_PRIVATE_KEY_MAINNET,
      signer2Key: SIGNER2_PRIVATE_KEY_MAINNET,
    };
  } else if (network === 'testnet') {
    return {
      rpcUrl: RPC_URL_TESTNET,
      ingressAddress: NODE_INGRESS_ADDRESS_TESTNET,
      signer1Key: SIGNER1_PRIVATE_KEY_TESTNET,
      signer2Key: SIGNER2_PRIVATE_KEY_TESTNET,
    };
  }
  throw new Error(`Unknown network: ${network}`);
}

/**
 * Generic retry helper that executes an async function with retries.
 * 
 * @param {Function} fn - Async function to execute
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} delayMs - Delay between retries in milliseconds
 * @param {string} operationName - Name of operation for logging
 * @returns {Promise<*>} Result from the function, or null if all retries fail
 */
async function retryOperation(fn, maxRetries, delayMs, operationName) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    
    if (attempt < maxRetries) {
      console.log(`🔄 ${operationName} attempt ${attempt} failed, retrying in ${delayMs/1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return null;
}

/**
 * Estimates gas for a transaction with fallback to default value.
 * 
 * @param {Function} estimateFn - Gas estimation function
 * @param {number} defaultGas - Default gas limit if estimation fails
 * @param {number} buffer - Additional gas buffer to add
 * @param {number} baseGas - Base gas limit to pass to estimate function
 * @returns {Promise<BigNumber>} Estimated gas limit with buffer
 */
async function estimateGasWithFallback(estimateFn, defaultGas, buffer, baseGas = 300000) {
  try {
    const estimate = await estimateFn(baseGas);
    return estimate.add(ethers.utils.bigNumberify(buffer));
  } catch (e) {
    return ethers.utils.bigNumberify(defaultGas + buffer);
  }
}

/**
 * Finds a pending multisig transaction ID for a specific enode and action.
 * Searches through all pending transactions and matches by function signature and parameters.
 * 
 * @param {Contract} nodeRules - NodeRules contract instance
 * @param {Object} enode - { enodeHigh, enodeLow, ip, port }
 * @param {string} action - Action type: 'add' or 'revoke'
 * @returns {Promise<number|null>} Transaction ID if found, null otherwise
 */
async function findPendingTransactionTxId(nodeRules, enode, action) {
  // Get count of pending (not yet executed) transactions
  const count = await nodeRules.getTransactionCount(true, false);
  if (count.eq(0)) return null;
  
  // Get all pending transaction IDs
  const ids = await nodeRules.getTransactionIds(0, count, true, false);
  
  const storageIface = new ethers.utils.Interface(NODE_STORAGE_ABI);
  const targetSig = action === 'add' 
    ? FUNCTION_SIGNATURES.ADD_NODE_PAYLOAD
    : FUNCTION_SIGNATURES.REMOVE_NODE_PAYLOAD;
  
  // Search through all pending transactions
  for (const id of ids) {
    const [, executed] = await nodeRules.getTransactionPayload(id);
    if (executed) continue; // Skip already executed transactions
    
    try {
      const [payload] = await nodeRules.getTransactionPayload(id);
      const data = String(payload);
      if (!data.toLowerCase().startsWith(targetSig.toLowerCase())) continue;

      // Decode and compare the first 4 params (enodeHigh, enodeLow, ip, port)
      const decoded = (() => {
        try {
          if (action === 'add') {
            return storageIface.decodeFunctionData('add', data);
          } else {
            return storageIface.decodeFunctionData('remove', data);
          }
        } catch (_) { return null; }
      })();
      if (!decoded) continue;

      const [dHigh, dLow, dIp, dPort] = decoded;
      const match =
        String(dHigh).toLowerCase() === String(enode.enodeHigh).toLowerCase() &&
        String(dLow).toLowerCase() === String(enode.enodeLow).toLowerCase() &&
        String(dIp).toLowerCase() === String(enode.ip).toLowerCase() &&
        String(dPort).toString() === ethers.utils.bigNumberify(enode.port).toString();
      if (match) return id.toNumber();
    } catch (e) {
      console.log(`⚠️ Could not get payload for transaction ${id}:`, e.message);
    }
  }
  return null;
}

/**
 * Polls and waits for a multisig transaction to be executed.
 * 
 * @param {Contract} accountRules - AccountRules contract instance
 * @param {number} txId - Transaction ID to wait for
 * @param {number} timeoutMs - Maximum time to wait in milliseconds
 * @param {number} intervalMs - Polling interval in milliseconds
 * @returns {Promise<boolean>} True if executed within timeout, false otherwise
 */
async function waitExecuted(accountRules, txId, timeoutMs = MULTISIG_EXECUTION_TIMEOUT_MS, intervalMs = POLLING_INTERVAL_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const [, executed] = await accountRules.getTransactionPayload(txId);
    if (executed) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Verifies that both signers have the necessary permissions (via Admin contract).
 * 
 * @param {Contract} adminContract - Admin contract instance
 * @param {string} signer1Address - First signer address
 * @param {string} signer2Address - Second signer address
 * @throws {Error} If either signer lacks permissions
 */
async function verifySignerPermissions(adminContract, signer1Address, signer2Address) {
  console.log('🔐 Verifying signer permissions...');
  console.log(`  🔑 Signer1 (initiator): ${signer1Address}`);
  console.log(`  🔑 Signer2 (confirmer): ${signer2Address}`);
  
  const signer1Permitted = await adminContract.isAuthorized(signer1Address);
  const signer2Permitted = await adminContract.isAuthorized(signer2Address);
  
  if (!signer1Permitted) {
    throw new Error('❌ Signer1 does not have permissions');
  }
  if (!signer2Permitted) {
    throw new Error('❌ Signer2 does not have permissions');
  }
  
  console.log('✅ OK, both signers have permissions!');
}

/**
 * Checks current permission status and exits early if operation is unnecessary.
 * 
 * @param {Contract} nodeRules - NodeRules contract instance
 * @param {Object} enode - { enodeHigh, enodeLow, ip, port }
 * @param {string} action - Action type: 'add' or 'revoke'
 * @returns {Promise<boolean>} True if should continue, false if should exit early
 */
async function checkPermissionStatus(nodeRules, enode, action) {
  const exists = await nodeExists(nodeRules, enode);
  if (action === 'add') {
    if (exists) {
      console.log(`ℹ️ Enode already exists (skipping): ${enode.enodeHigh}${enode.enodeLow}`);
      return false;
    }
    console.log(`➕ Adding enode: ${enode.enodeHigh}${enode.enodeLow}`);
  } else {
    if (!exists) {
      console.log(`ℹ️ Enode not found (skipping revoke): ${enode.enodeHigh}${enode.enodeLow}`);
      return false;
    }
    console.log(`🗑️ Removing enode: ${enode.enodeHigh}${enode.enodeLow}`);
  }
  return true;
}

async function nodeExists(nodeRules, enode) {
  try {
    const size = await nodeRules.getSize();
    const total = size.toNumber ? size.toNumber() : Number(size);
    for (let i = 0; i < total; i++) {
      const [h, l, ip, port] = await nodeRules.getByIndex(i);
      const match =
        String(h).toLowerCase() === String(enode.enodeHigh).toLowerCase() &&
        String(l).toLowerCase() === String(enode.enodeLow).toLowerCase() &&
        String(ip).toLowerCase() === String(enode.ip).toLowerCase() &&
        String(port).toString() === ethers.utils.bigNumberify(enode.port).toString();
      if (match) return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Submits the initial transaction (add or remove enode) using signer1.
 * 
 * @param {Contract} nodeRules1 - NodeRules contract with signer1
 * @param {string} action - Action type: 'add' or 'revoke'
 * @param {Object} enode - { enodeHigh, enodeLow, ip, port, nodeType, geoHash, name, organization, did, group }
 * @param {string} signer1Address - Signer1 address for logging
 * @returns {Promise<Object>} Transaction object
 */
async function submitTransaction(nodeRules1, action, enode, signer1Address) {
  let tx;
  
  if (action === 'add') {
    const gasLimit = await estimateGasWithFallback(
      (baseGas) => nodeRules1.estimate.addEnode(
        enode.enodeHigh,
        enode.enodeLow,
        enode.ip,
        ethers.utils.bigNumberify(enode.port),
        enode.nodeType,
        enode.geoHash,
        enode.name,
        enode.organization,
        enode.did,
        enode.group,
        { gasLimit: baseGas, gasPrice: 0 }
      ),
      GAS_LIMIT_ADD_ACCOUNT,
      GAS_BUFFER
    );
    tx = await nodeRules1.functions.addEnode(
      enode.enodeHigh,
      enode.enodeLow,
      enode.ip,
      ethers.utils.bigNumberify(enode.port),
      enode.nodeType,
      enode.geoHash,
      enode.name,
      enode.organization,
      enode.did,
      enode.group,
      { gasLimit, gasPrice: 0 }
    );
    console.log(`📤 ➕ addEnode(...) | sent by initiator (${signer1Address})`);
  } else {
    const gasLimit = await estimateGasWithFallback(
      (baseGas) => nodeRules1.estimate.removeEnode(
        enode.enodeHigh,
        enode.enodeLow,
        enode.ip,
        ethers.utils.bigNumberify(enode.port),
        { gasLimit: baseGas, gasPrice: 0 }
      ),
      GAS_LIMIT_REMOVE_ACCOUNT,
      GAS_BUFFER
    );
    tx = await nodeRules1.functions.removeEnode(
      enode.enodeHigh,
      enode.enodeLow,
      enode.ip,
      ethers.utils.bigNumberify(enode.port),
      { gasLimit, gasPrice: 0 }
    );
    console.log(`📤 ➖ removeEnode(...) | sent by initiator (${signer1Address})`);
  }
  
  console.log(`⛓️ Transaction hash: ${tx.hash}`);
  return tx;
}

/**
 * Waits for transaction confirmation with timeout.
 * 
 * @param {Object} tx - Transaction object
 * @param {number} timeoutMs - Timeout in milliseconds
 * @throws {Error} If transaction times out
 */
async function waitForConfirmation(tx, timeoutMs = TX_CONFIRMATION_TIMEOUT_MS) {
  console.log('⏳ ...');
  try {
    const receipt = await Promise.race([
      tx.wait(1),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)
      )
    ]);
    console.log(`✅ Transaction confirmed at block: ${receipt.blockNumber}`);
  } catch (e) {
    if (e.message === 'TIMEOUT') {
      throw new Error('⏰ Transaction timeout - signer may not have permissions or node is down');
    }
    throw e;
  }
}

/**
 * Confirms a multisig transaction with the second signer if needed.
 * 
 * @param {Contract} accountRules1 - AccountRules with signer1 (for reading)
 * @param {Contract} accountRules2 - AccountRules with signer2 (for confirming)
 * @param {number} txId - Transaction ID to confirm
 * @param {string} signer2Address - Signer2 address
 */
async function confirmMultisigTransaction(accountRules1, accountRules2, txId, signer2Address) {
  const [, txExecuted] = await accountRules1.getTransactionPayload(txId);
  
  if (txExecuted) {
    console.log('✅ Transaction already executed, skipping confirmation');
    return;
  }
  
  const confirmations = await accountRules1.getConfirmations(txId);
  const confirmationCount = await accountRules1.getConfirmationCount(txId);
  console.log(`📋 Current confirmations: ${confirmationCount} from: ${confirmations.join(', ')}`);
  
  const alreadyConfirmed = confirmations.map(a => a.toLowerCase()).includes(signer2Address.toLowerCase());
  
  if (alreadyConfirmed) {
    console.log(`ℹ️ Signer2 (${signer2Address}) already confirmed this transaction`);
    return;
  }
  
  // Submit confirmation
  try {
    const est = await accountRules2.estimate.confirmTransaction(txId, { gasLimit: 300000, gasPrice: 0 });
    const gasLimit = est.toNumber() + 300000;
    console.log(`⏳ ...`);    
    const confirmTx = await accountRules2.functions.confirmTransaction(txId, { gasLimit, gasPrice: 0 });
    console.log(`✍️ confirmTransaction by confirmer (${signer2Address}): ${confirmTx.hash}`);
    await waitForConfirmation(confirmTx);
  } catch (e) {
    console.error('❌ Error confirming transaction:', e.message);
    throw e;
  }
}

/**
 * Verifies the final state after transaction execution.
 * 
 * @param {Contract} nodeRules - NodeRules contract instance
 * @param {Object} enode - target enode
 * @param {string} action - Action type: 'add' or 'revoke'
 * @param {number} txId - Transaction ID that was executed
 */
async function verifyFinalState(nodeRules, enode, action, txId) {
  const executed = await waitExecuted(nodeRules, txId);
  console.log(`⏳ ...`);    
  console.log(`🔄 Multisig execution status: ${executed ? '✅ completed' : '⏰ timeout'}`);
  
  const exists = await nodeExists(nodeRules, enode);
  console.log(`⏳ ...`);    
  console.log(`🔍 nodeExists(...) = ${exists}`);
  
  if (action === 'add') {
    if (!exists) {
      process.exitCode = 2;
      console.error('❌ ERROR: Enode not found after completion. Check multisig threshold.');
    } else {
      console.log('🎉 Success: ENODE ADDED!');
    }
  } else {
    if (exists) {
      process.exitCode = 2;
      console.error('❌ ERROR: Enode still present after completion. Check multisig threshold.');
    } else {
      console.log('🎉 Success: ENODE REMOVED!');
    }
  }
}

// =============================================================================
// MAIN EXECUTION
// =============================================================================

(async () => {
  // Parse and validate arguments
  const ARGS = parseArgs(process.argv);
  const ACTION = ARGS.action || 'add';
  const ENODE_URL = ARGS.enode || ARGS.address; // support legacy --address param
  const NETWORK = ARGS.network;
  
  const networkConfig = getNetworkConfig(NETWORK);
  validateInputs(ARGS, networkConfig);
  
  // Setup provider and signers
  const provider = new ethers.providers.JsonRpcProvider({
    url: networkConfig.rpcUrl,
    timeout: PROVIDER_TIMEOUT_MS
  });
  
  const signer1 = new ethers.Wallet(networkConfig.signer1Key, provider);
  const signer2 = new ethers.Wallet(networkConfig.signer2Key, provider);
  
  // Get NodeRules and Admin contract addresses from NodeIngress
  const ingress = new ethers.Contract(networkConfig.ingressAddress, NODE_INGRESS_ABI, provider);
  const RULES_KEY = await ingress.RULES_CONTRACT();
  const ADMIN_KEY = await ingress.ADMIN_CONTRACT();
  const nodeRulesAddress = await ingress.getContractAddress(RULES_KEY);
  const adminAddress = await ingress.getContractAddress(ADMIN_KEY);
  
  if (!nodeRulesAddress || nodeRulesAddress === ethers.constants.AddressZero) {
    throw new Error('❌ NodeRules address is not configured in NodeIngress');
  }
  if (!adminAddress || adminAddress === ethers.constants.AddressZero) {
    throw new Error('❌ Admin address is not configured in NodeIngress');
  }
  
  console.log(`🔗 Using NodeRules at: ${nodeRulesAddress}`);
  console.log(`🔗 Using Admin at: ${adminAddress}`);
  
  // Create contract instances with each signer
  const nodeRules1 = new ethers.Contract(nodeRulesAddress, NODE_RULES_ABI, signer1);
  const nodeRules2 = new ethers.Contract(nodeRulesAddress, NODE_RULES_ABI, signer2);
  const adminContract = new ethers.Contract(adminAddress, ADMIN_ABI, provider);
  
  // Get signer addresses
  const signer1Address = await signer1.getAddress();
  const signer2Address = await signer2.getAddress();
  
  // Step 1: Verify signers have admin permissions
  await verifySignerPermissions(adminContract, signer1Address, signer2Address);

  // Build enode parameters
  const base = parseEnodeUrl(ENODE_URL);
  const nodeType = resolveNodeType(ARGS.type || ARGS.nodeType);
  const geoHash = ARGS.geohash ? ARGS.geohash : hexFromAscii('jn41', 6); // default example geohash bytes6
  const name = ARGS.name || '';
  const organization = ARGS.organization || ARGS.org || '';
  const did = ARGS.did || 'NA';
  const group = ARGS.group || defaultGroupForType(nodeType);
  const ENODE_PARAMS = {
    ...base,
    nodeType,
    geoHash,
    name,
    organization,
    did,
    group
  };
  
  // Step 2: Check current permission status and exit early if needed
  const shouldContinue = await checkPermissionStatus(nodeRules1, ENODE_PARAMS, ACTION);
  if (!shouldContinue) return;
  
  // Step 3: Submit transaction with signer1
  const tx = await submitTransaction(nodeRules1, ACTION, ENODE_PARAMS, signer1Address);
  await waitForConfirmation(tx);
  
  // Step 4: Check if transaction auto-executed (single-sig mode)
  const nowExists = await nodeExists(nodeRules1, ENODE_PARAMS);
  const expectedExists = ACTION === 'add';
  if (nowExists === expectedExists) {
    console.log('⚡ Transaction auto-executed successfully (single-signature mode)');
    console.log(`🔍 nodeExists(...) = ${nowExists}`);
    console.log(`🎉 Done: ${ACTION === 'add' ? 'enode added' : 'enode removed'} successfully.`);
    return;
  }
  
  // Step 5: Find pending multisig transaction with retry
  console.log('🔍 Looking for pending multisig transaction...');
  const txId = await retryOperation(
    () => findPendingTransactionTxId(nodeRules1, ENODE_PARAMS, ACTION),
    MAX_RETRIES,
    RETRY_DELAY_MS,
    'Finding pending transaction'
  );
  
  if (txId === null) {
    throw new Error(`❌ No pending transaction found for ${ACTION} action. Transaction may have auto-executed or failed.`);
  }
  console.log(`✅ Transaction ID found: ${txId}`);
  
  // Step 6: Confirm with signer2
  await confirmMultisigTransaction(nodeRules1, nodeRules2, txId, signer2Address);
  
  // Step 7: Wait for execution and verify final state
  await verifyFinalState(nodeRules1, ENODE_PARAMS, ACTION, txId);
  
})().catch(e => {
  console.error('💥 Fatal error:', e.message || e);
  process.exit(1);
});
