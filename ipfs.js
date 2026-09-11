import axios from "axios";
import FormData from "form-data";

const PINATA_JSON_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
const PINATA_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const GATEWAY = "https://gateway.pinata.cloud/ipfs";

// Upload an image buffer (e.g. downloaded from a Telegram photo) to Pinata.
export async function uploadImageToPinata(buffer, filename) {
  const form = new FormData();
  form.append("file", buffer, filename);

  const res = await axios.post(PINATA_FILE_URL, form, {
    maxBodyLength: Infinity,
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${process.env.PINATA_JWT}`,
    },
  });

  return `${GATEWAY}/${res.data.IpfsHash}`;
}

// Upload the token metadata JSON (name/symbol/image/description) to Pinata.
export async function uploadMetadataToPinata({ name, symbol, description, imageUri }) {
  const metadata = {
    name,
    symbol,
    description: description || "",
    image: imageUri,
  };

  const res = await axios.post(
    PINATA_JSON_URL,
    { pinataContent: metadata, pinataMetadata: { name: `${symbol}-metadata.json` } },
    { headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` } }
  );

  return `${GATEWAY}/${res.data.IpfsHash}`;
}
