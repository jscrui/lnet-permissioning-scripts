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

// AccountIngress contract addresses (same for both networks)
const ACCOUNT_INGRESS_ADDRESS_MAINNET = "0x0000000000000000000000000000000000008888";
const ACCOUNT_INGRESS_ADDRESS_TESTNET = "0x0000000000000000000000000000000000008888"; 

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

// Function signatures for payload matching
const FUNCTION_SIGNATURES = {
  ADD_ACCOUNT_UINT8: '0x60fc52ec',          // addAccount(address,uint8)
  ADD_ACCOUNT_UINT256: '0xc1ce56eb',        // addAccount(address,uint256)
  ADD_ACCOUNT_SIMPLE: '0xe89b0e1e',         // addAccount(address)
  REMOVE_ACCOUNT: '0xc4740a95'              // removeAccount(address)
};

// =============================================================================
// CONTRACT ABIs
// =============================================================================

// ABI for AccountIngress contract - used to get the AccountRules contract address
const ACCOUNT_INGRESS_ABI = [
  'function RULES_CONTRACT() view returns (bytes32)',
  'function getContractAddress(bytes32) view returns (address)',
];

// ABI for AccountRules contract - handles account permissioning and multisig
const ACCOUNT_RULES_ABI = [
  'function addAccount(address account,uint8 nodeType) returns (bool)',
  'function removeAccount(address account) returns (bool)',
  'function getTransactionCount(bool pending,bool executed) view returns (uint256)',
  'function getTransactionIds(uint256 from,uint256 to,bool pending,bool executed) view returns (uint256[])',
  'function getTransaction(uint256 txId) view returns (address account,bool isAccount,bool executed,uint256 id)',
  'function getTransactionPayload(uint256 txId) view returns (bytes payload, bool isAccount)',
  'function confirmTransaction(uint256 txId) returns (bool)',
  'function accountPermitted(address a) view returns (bool)',
  'function getConfirmationCount(uint256 txId) view returns (uint256)',
  'function getConfirmations(uint256 txId) view returns (address[])',
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

/**
 * Converts membership type string to numeric value.
 * 
 * @param {string} membershipType - Membership level: 'basic', 'standard', or 'premium'
 * @returns {number} Numeric membership value (0, 1, or 2)
 * @throws {Error} If membership type is invalid
 */
function membershipToNumber(membershipType) {
  switch(membershipType) {
    case 'basic': return 0;
    case 'standard': return 1;
    case 'premium': return 2;
    default: throw new Error(`Unknown membership type: ${membershipType}`);
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
  if (!args.address) {
    console.error('❌ Missing argument --address');
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

  // Validate membership for add action
  if (action === 'add' && !args.membership) {
    console.error('❌ Missing argument --membership (required for add action)');
    process.exit(1);
  }

  // Validate Ethereum address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(args.address)) {
    console.error('❌ Invalid Ethereum address. Check the address and try again.');
    process.exit(1);
  }

  // Validate membership type
  if (action === 'add' && !['basic', 'standard', 'premium'].includes(args.membership)) {
    console.error('❌ Invalid membership type. Expected: basic, standard, premium.');
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
      ingressAddress: ACCOUNT_INGRESS_ADDRESS_MAINNET,
      signer1Key: SIGNER1_PRIVATE_KEY_MAINNET,
      signer2Key: SIGNER2_PRIVATE_KEY_MAINNET,
    };
  } else if (network === 'testnet') {
    return {
      rpcUrl: RPC_URL_TESTNET,
      ingressAddress: ACCOUNT_INGRESS_ADDRESS_TESTNET,
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
 * Finds a pending multisig transaction ID for a specific account and action.
 * Searches through all pending transactions and matches by function signature and target address.
 * 
 * @param {Contract} accountRules - AccountRules contract instance
 * @param {string} targetAddress - Target Ethereum address to find
 * @param {string} action - Action type: 'add' or 'revoke'
 * @returns {Promise<number|null>} Transaction ID if found, null otherwise
 */
async function findPendingTransactionTxId(accountRules, targetAddress, action) {
  // Get count of pending (not yet executed) transactions
  const count = await accountRules.getTransactionCount(true, false);
  if (count.eq(0)) return null;
  
  // Get all pending transaction IDs
  const ids = await accountRules.getTransactionIds(0, count, true, false);
  
  // Determine which function signatures to look for based on action
  const targetSigs = action === 'add' 
    ? [FUNCTION_SIGNATURES.ADD_ACCOUNT_UINT8, FUNCTION_SIGNATURES.ADD_ACCOUNT_UINT256, FUNCTION_SIGNATURES.ADD_ACCOUNT_SIMPLE]
    : [FUNCTION_SIGNATURES.REMOVE_ACCOUNT];
  
  // Search through all pending transactions
  for (const id of ids) {
    const [, , executed] = await accountRules.getTransaction(id);
    if (executed) continue; // Skip already executed transactions
    
    try {
      const [payload] = await accountRules.getTransactionPayload(id);
      const payloadStr = String(payload);
      
      // Check if payload matches any target signature
      for (const targetSig of targetSigs) {
        if (payloadStr.toLowerCase().startsWith(targetSig.toLowerCase())) {
          // Extract address from payload (bytes 4-36 contain the address parameter)
          const addressInPayload = '0x' + payloadStr.slice(34, 74);
          if (addressInPayload.toLowerCase() === targetAddress.toLowerCase()) {
            return id.toNumber();
          }
        }
      }
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
    const [, , executed] = await accountRules.getTransaction(txId);
    if (executed) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Verifies that both signers have the necessary permissions to execute operations.
 * 
 * @param {Contract} accountRules - AccountRules contract instance
 * @param {string} signer1Address - First signer address
 * @param {string} signer2Address - Second signer address
 * @throws {Error} If either signer lacks permissions
 */
async function verifySignerPermissions(accountRules, signer1Address, signer2Address) {
  console.log('🔐 Verifying signer permissions...');
  console.log(`  🔑 Signer1 (initiator): ${signer1Address}`);
  console.log(`  🔑 Signer2 (confirmer): ${signer2Address}`);
  
  const signer1Permitted = await accountRules.accountPermitted(signer1Address);
  const signer2Permitted = await accountRules.accountPermitted(signer2Address);
  
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
 * @param {Contract} accountRules - AccountRules contract instance
 * @param {string} account - Target account address
 * @param {string} action - Action type: 'add' or 'revoke'
 * @param {string} membershipType - Membership type (for add action)
 * @returns {Promise<boolean>} True if should continue, false if should exit early
 */
async function checkPermissionStatus(accountRules, account, action, membershipType) {
  const isPermitted = await accountRules.accountPermitted(account);
  
  if (action === 'add') {
    if (isPermitted) {
      console.log(`ℹ️ Address is already permitted: ${account}`);
      return false;
    }
    console.log(`➕ Adding account: ${account} with membership: ${membershipType}`);
  } else {
    if (!isPermitted) {
      console.log(`ℹ️ Address is not currently permitted: ${account}`);
      return false;
    }
    console.log(`🗑️ Revoking permission for account: ${account}`);
  }
  
  return true;
}

/**
 * Submits the initial transaction (add or remove account) using signer1.
 * 
 * @param {Contract} accountRules1 - AccountRules contract with signer1
 * @param {string} action - Action type: 'add' or 'revoke'
 * @param {string} account - Target account address
 * @param {string} membershipType - Membership type (for add action)
 * @param {string} signer1Address - Signer1 address for logging
 * @returns {Promise<Object>} Transaction object
 */
async function submitTransaction(accountRules1, action, account, membershipType, signer1Address) {
  let tx;
  
  if (action === 'add') {
    const membership = membershipToNumber(membershipType);
    const gasLimit = await estimateGasWithFallback(
      (baseGas) => accountRules1.estimate['addAccount(address,uint8)'](account, membership, { gasLimit: baseGas, gasPrice: 0 }),
      GAS_LIMIT_ADD_ACCOUNT,
      GAS_BUFFER
    );
    tx = await accountRules1.functions['addAccount(address,uint8)'](account, membership, { gasLimit, gasPrice: 0 });
    console.log(`📤 ➕ addAccount(address,uint8) | sent by initiator (${signer1Address})`);
  } else {
    const gasLimit = await estimateGasWithFallback(
      (baseGas) => accountRules1.estimate.removeAccount(account, { gasLimit: baseGas, gasPrice: 0 }),
      GAS_LIMIT_REMOVE_ACCOUNT,
      GAS_BUFFER
    );
    tx = await accountRules1.functions.removeAccount(account, { gasLimit, gasPrice: 0 });
    console.log(`📤 ➖ removeAccount(address) | sent by initiator (${signer1Address})`);
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
  const [, , txExecuted] = await accountRules1.getTransaction(txId);
  
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
    console.log('⏳ ...');
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
 * @param {Contract} accountRules - AccountRules contract instance
 * @param {string} account - Target account address
 * @param {string} action - Action type: 'add' or 'revoke'
 * @param {number} txId - Transaction ID that was executed
 */
async function verifyFinalState(accountRules, account, action, txId) {
  const executed = await waitExecuted(accountRules, txId);
  console.log('⏳ ...');
  console.log(`🔄 Multisig execution status: ${executed ? '✅ completed' : '⏰ timeout'}`);
  
  const permitted = await accountRules.accountPermitted(account);
  console.log('⏳ ...');
  console.log(`🔍 accountPermitted(${account}) = ${permitted}`);
  
  if (action === 'add') {
    if (!permitted) {
      process.exitCode = 2;
      console.error('❌ ERROR: Not permitted after completion. Check multisig threshold.');
    } else {
      console.log('🎉 Success: ADDRESS PERMITTED!');
    }
  } else {
    if (permitted) {
      process.exitCode = 2;
      console.error('❌ ERROR: Still permitted after completion. Check multisig threshold.');
    } else {
      console.log('🎉 Success: ADDRESS REVOKED!');
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
  const NEW_ACCOUNT = ARGS.address;
  const MEMBERSHIP_TYPE = ARGS.membership;
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
  
  // Get AccountRules contract address from AccountIngress
  const ingress = new ethers.Contract(networkConfig.ingressAddress, ACCOUNT_INGRESS_ABI, provider);
  const RULES_KEY = await ingress.RULES_CONTRACT();
  const accountRulesAddress = await ingress.getContractAddress(RULES_KEY);
  
  if (!accountRulesAddress || accountRulesAddress === ethers.constants.AddressZero) {
    throw new Error('❌ AccountRules address is not configured in AccountIngress');
  }
  
  console.log(`🔗 Using AccountRules at: ${accountRulesAddress}`);
  
  // Create contract instances with each signer
  const accountRules1 = new ethers.Contract(accountRulesAddress, ACCOUNT_RULES_ABI, signer1);
  const accountRules2 = new ethers.Contract(accountRulesAddress, ACCOUNT_RULES_ABI, signer2);
  
  // Get signer addresses
  const signer1Address = await signer1.getAddress();
  const signer2Address = await signer2.getAddress();
  
  // Step 1: Verify signers have permissions
  await verifySignerPermissions(accountRules1, signer1Address, signer2Address);
  
  // Step 2: Check current permission status and exit early if needed
  const shouldContinue = await checkPermissionStatus(accountRules1, NEW_ACCOUNT, ACTION, MEMBERSHIP_TYPE);
  if (!shouldContinue) return;
  
  // Step 3: Submit transaction with signer1
  const tx = await submitTransaction(accountRules1, ACTION, NEW_ACCOUNT, MEMBERSHIP_TYPE, signer1Address);
  await waitForConfirmation(tx);
  
  // Step 4: Check if transaction auto-executed (single-sig mode)
  const isPermittedNow = await accountRules1.accountPermitted(NEW_ACCOUNT);
  const expectedPermission = ACTION === 'add';
  
  if (isPermittedNow === expectedPermission) {
    console.log('⚡ Transaction auto-executed successfully (single-signature mode)');
    console.log(`🔍 accountPermitted(${NEW_ACCOUNT}) = ${isPermittedNow}`);
    console.log(`🎉 Done: ${ACTION === 'add' ? 'address permitted' : 'permission revoked'} successfully.`);
    return;
  }
  
  // Step 5: Find pending multisig transaction with retry
  console.log('🔍 Looking for pending multisig transaction...');
  const txId = await retryOperation(
    () => findPendingTransactionTxId(accountRules1, NEW_ACCOUNT, ACTION),
    MAX_RETRIES,
    RETRY_DELAY_MS,
    'Finding pending transaction'
  );
  
  if (txId === null) {
    throw new Error(`❌ No pending transaction found for ${ACTION} action. Transaction may have auto-executed or failed.`);
  }
  console.log(`✅ Transaction ID found: ${txId}`);
  
  // Step 6: Confirm with signer2
  await confirmMultisigTransaction(accountRules1, accountRules2, txId, signer2Address);
  
  // Step 7: Wait for execution and verify final state
  await verifyFinalState(accountRules1, NEW_ACCOUNT, ACTION, txId);
  
})().catch(e => {
  console.error('💥 Fatal error:', e.message || e);
  process.exit(1);
});
