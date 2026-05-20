import { SplitV2Client } from "@0xsplits/splits-sdk";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  keccak256,
  parseUnits,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { AtlasFundedSplit, PrepareLootiCampaignResult } from "./looti.js";

export interface FundPreparedLootiSplitInput {
  idempotencyKey: string;
  treasuryPrivateKey: Hex;
  expectedTreasuryAddress?: Address;
  tokenAddress: Address;
  tokenDecimals: number;
  amount: number;
  controllerAddress: Address;
  chainId: number;
  rpcUrl?: string;
  allowReuseDeployedSplit?: boolean;
  allowAdditionalFunding?: boolean;
}

export interface FundPreparedLootiSplitResult {
  fundedSplit: AtlasFundedSplit;
  amountInBaseUnits: string;
  treasuryWalletAddress: Address;
}

export async function fundPreparedLootiSplit(
  input: FundPreparedLootiSplitInput
): Promise<FundPreparedLootiSplitResult> {
  if (input.chainId !== base.id) {
    throw new Error(`Only Base chain ${base.id} is supported in V0, received ${input.chainId}`);
  }

  if (input.tokenAddress === zeroAddress) {
    throw new Error("Native ETH funding is not supported for Looti campaigns in V0");
  }

  const account = privateKeyToAccount(input.treasuryPrivateKey);
  if (
    input.expectedTreasuryAddress &&
    account.address.toLowerCase() !== input.expectedTreasuryAddress.toLowerCase()
  ) {
    throw new Error("ATLAS_TREASURY_PRIVATE_KEY does not match ATLAS_TREASURY_WALLET_ADDRESS");
  }

  const transport = http(input.rpcUrl);
  const publicClient = createPublicClient({
    chain: base,
    transport,
  });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport,
  });
  const splitsClient = new SplitV2Client({
    chainId: base.id,
    publicClient: publicClient as PublicClient,
    walletClient: walletClient as WalletClient,
    includeEnsNames: false,
  });
  const amountInBaseUnits = parseUnits(String(input.amount), input.tokenDecimals);
  const nativeBalance = await publicClient.getBalance({ address: account.address });
  if (nativeBalance === 0n) {
    throw new Error("Treasury wallet has 0 ETH on Base; fund it with ETH for gas before launch");
  }

  const tokenBalance = await publicClient.readContract({
    address: input.tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (tokenBalance < amountInBaseUnits) {
    throw new Error(
      `Treasury wallet token balance is below campaign budget: needs ${amountInBaseUnits}, has ${tokenBalance}`
    );
  }

  const splitArgs = {
    recipients: [
      {
        address: input.controllerAddress,
        percentAllocation: 100,
      },
    ],
    distributorFeePercent: 0,
    ownerAddress: input.controllerAddress,
    creatorAddress: account.address,
    splitType: "pull",
    salt: deterministicSalt(input.idempotencyKey),
  } as const;

  const existing = await splitsClient.isDeployed(splitArgs as any);
  if (existing.deployed && !input.allowReuseDeployedSplit) {
    throw new Error(
      `Deterministic split ${existing.splitAddress} already exists for ${input.idempotencyKey}; refusing to risk duplicate funding`
    );
  }
  if (existing.deployed && !input.allowAdditionalFunding) {
    throw new Error(
      `Deterministic split ${existing.splitAddress} already exists; refusing to add more funds without allowAdditionalFunding`
    );
  }

  const createSplitResponse = existing.deployed
    ? undefined
    : await splitsClient.createSplit(splitArgs as any);
  const splitAddress = existing.deployed ? existing.splitAddress : createSplitResponse!.splitAddress;
  const splitCreationTxHash = existing.deployed
    ? "already_deployed"
    : readTransactionHash(createSplitResponse!.event);

  const fundingTxHash = await walletClient.writeContract({
    address: input.tokenAddress,
    abi: erc20Abi,
    functionName: "transfer",
    args: [splitAddress, amountInBaseUnits],
    account,
    chain: base,
  });

  await publicClient.waitForTransactionReceipt({ hash: fundingTxHash });

  return {
    fundedSplit: {
      mode: "atlas_treasury_splits_v2",
      splitAddress,
      splitCreationTxHash,
      fundingTxHash,
      splitType: "pull",
      controller: input.controllerAddress,
    },
    amountInBaseUnits: amountInBaseUnits.toString(),
    treasuryWalletAddress: account.address,
  };
}

export function buildFundingInputFromPrepare(input: {
  idempotencyKey: string;
  treasuryPrivateKey: Hex;
  expectedTreasuryAddress?: Address;
  prepareResult: PrepareLootiCampaignResult;
  allowReuseDeployedSplit?: boolean;
  allowAdditionalFunding?: boolean;
  rpcUrl?: string;
}): FundPreparedLootiSplitInput {
  return {
    idempotencyKey: input.idempotencyKey,
    treasuryPrivateKey: input.treasuryPrivateKey,
    expectedTreasuryAddress: input.expectedTreasuryAddress,
    tokenAddress: input.prepareResult.fundingInstruction.tokenAddress as Address,
    tokenDecimals: input.prepareResult.fundingInstruction.tokenDecimals,
    amount: input.prepareResult.fundingInstruction.amount,
    controllerAddress: input.prepareResult.split.controller as Address,
    chainId: input.prepareResult.fundingInstruction.chainId,
    rpcUrl: input.rpcUrl,
    allowReuseDeployedSplit: input.allowReuseDeployedSplit,
    allowAdditionalFunding: input.allowAdditionalFunding,
  };
}

function deterministicSalt(idempotencyKey: string): Hex {
  return keccak256(toBytes(`atlas-looti:${idempotencyKey}`));
}

function readTransactionHash(event: unknown): Hex {
  const hash = (event as { transactionHash?: unknown }).transactionHash;
  if (typeof hash !== "string" || !hash.startsWith("0x")) {
    throw new Error("Splits SDK did not return a split creation transaction hash");
  }

  return hash as Hex;
}
