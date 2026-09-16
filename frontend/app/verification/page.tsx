import EmailVerification from "@/components/email-verification";

/**
 * Cible du lien envoyé par courriel : `/verification?token=...`.
 *
 * Le jeton arrive en paramètre de requête et non dans le chemin : c'est la
 * forme qu'on peut changer sans casser les liens déjà partis dans des boîtes.
 */
export default async function Page(props: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await props.searchParams;
  return <EmailVerification token={token} />;
}
