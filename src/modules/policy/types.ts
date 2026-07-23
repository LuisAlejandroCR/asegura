interface PetDetail {
  name: string;
  age: string;
  breed: string;
}

interface Policy {
  id: string;
  conversation_id: string | null;
  product_id: string;
  cedula: string;
  nombre: string;
  email: string | null;
  monthly_premium: number;
  pet_count: number | null;
  pets: PetDetail[] | null;
  status: string;
  wompi_link_id: string | null;
  celo_tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

export { Policy, PetDetail };
