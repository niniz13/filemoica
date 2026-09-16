import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Image Docker minimale : ne copie que les fichiers réellement nécessaires
  // à l'exécution, sans le node_modules complet. Voir frontend/Dockerfile.
  output: "standalone",
};

export default nextConfig;
