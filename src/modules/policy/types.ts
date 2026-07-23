interface Policy {
  id: string;
  conversation_id: string | null;
  product_id: string;
  cedula: string;
  nombre: string;
  email: string | null;
  monthly_premium: number;
  status: string;
  wompi_link_id: string | null;
  celo_tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

export { Policy };
