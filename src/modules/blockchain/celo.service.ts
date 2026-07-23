// celo.service.ts: registers issued policies on Celo Mainnet via AseguraLedger contract
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

const LEDGER_ABI = [
  'function registerPolicy(string policyId, string referenceURI) external',
  'function verifyPolicy(string policyId) external view returns (bool)',
  'event PolicyRegistered(bytes32 indexed policyHash, string policyId, string referenceURI, address indexed operator, uint256 timestamp)',
];

export interface RegistrationResult {
  txHash: string | null;
  celoscanUrl: string | null;
}

@Injectable()
export class CeloService {
  private readonly logger = new Logger(CeloService.name);
  private readonly enabled: boolean;
  private contract: ethers.Contract | null = null;

  constructor(private readonly config: ConfigService) {
    const rpcUrl = config.get<string>('CELO_RPC_URL');
    const privateKey = config.get<string>('OPERATOR_PRIVATE_KEY');
    const ledgerAddress = config.get<string>('POLICY_LEDGER_ADDRESS');

    this.enabled = !!(rpcUrl && privateKey && ledgerAddress);

    if (this.enabled && rpcUrl && privateKey && ledgerAddress) {
      try {
        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        const wallet = new ethers.Wallet(privateKey, provider);
        this.contract = new ethers.Contract(ledgerAddress, LEDGER_ABI, wallet);
        this.logger.log(`Celo enabled — operator: ${wallet.address} — ledger: ${ledgerAddress}`);
      } catch (err) {
        this.logger.error(`Failed to initialize Celo client: ${err}`);
      }
    } else {
      this.logger.warn('Celo disabled — CELO_RPC_URL, OPERATOR_PRIVATE_KEY or POLICY_LEDGER_ADDRESS not set');
    }
  }

  async registerPolicy(policyId: string, referenceURI: string): Promise<RegistrationResult> {
    if (!this.contract) {
      this.logger.warn(`Celo registration skipped for policy ${policyId} — not configured`);
      return { txHash: null, celoscanUrl: null };
    }

    try {
      const tx: ethers.ContractTransaction = await this.contract.registerPolicy(policyId, referenceURI);
      const receipt = await tx.wait();

      const celoscanUrl = `https://celoscan.io/tx/${receipt.transactionHash}`;
      this.logger.log(`Policy ${policyId} registered on Celo: ${celoscanUrl}`);
      return { txHash: receipt.transactionHash, celoscanUrl };
    } catch (err) {
      this.logger.error(`Celo registration failed for ${policyId}: ${err}`);
      return { txHash: null, celoscanUrl: null };
    }
  }

  async isRegistered(policyId: string): Promise<boolean> {
    if (!this.contract) return false;
    try {
      return await this.contract.verifyPolicy(policyId) as boolean;
    } catch {
      return false;
    }
  }
}
