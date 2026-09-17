"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ApiError, api } from "@/lib/api";

const sansFont = "var(--font-space-grotesk), system-ui, sans-serif";

type Etat = "en-cours" | "confirmee" | "echec";

/**
 * Page ouverte depuis le lien reçu par courriel.
 *
 * Confirme l'adresse dès l'arrivée : demander un clic supplémentaire
 * n'apporterait rien, la personne a déjà cliqué dans son courriel.
 */
export default function EmailVerification({ token }: { token?: string }) {
  const [etat, setEtat] = useState<Etat>(token ? "en-cours" : "echec");
  const [message, setMessage] = useState<string | null>(
    token ? null : "Ce lien est incomplet : il ne contient aucun jeton.",
  );

  // React lance deux fois les effets en mode strict. Sans ce garde, le second
  // appel trouverait un jeton déjà consommé et afficherait un échec sur une
  // confirmation qui vient pourtant de réussir.
  const dejaTente = useRef(false);

  useEffect(() => {
    if (!token || dejaTente.current) return;
    dejaTente.current = true;

    api
      .verifyEmail(token)
      .then(() => setEtat("confirmee"))
      .catch((err) => {
        setEtat("echec");
        setMessage(
          err instanceof ApiError
            ? err.message
            : "La confirmation a échoué. Réessayez depuis un lien récent.",
        );
      });
  }, [token]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f6f4f0",
        padding: 20,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 460,
          background: "#ffffff",
          borderRadius: 22,
          padding: "34px 30px",
        }}
      >
        <div style={{ font: `500 17px/1 ${sansFont}`, letterSpacing: "-.01em" }}>
          File Moi Ça
        </div>

        {etat === "en-cours" && (
          <p style={{ marginTop: 26, font: `400 14px/1.5 ${sansFont}`, color: "#6b7178" }}>
            Confirmation en cours…
          </p>
        )}

        {etat === "confirmee" && (
          <>
            <h1 style={{ margin: "26px 0 0", font: `400 26px/1.2 ${sansFont}`, color: "#16181c" }}>
              Adresse confirmée
            </h1>
            <p style={{ marginTop: 12, font: `400 14px/1.6 ${sansFont}`, color: "#3b4046" }}>
              Votre compte est actif. Vous pouvez maintenant vous connecter.
            </p>
            <Link
              href="/"
              className="ftc-btn-primary"
              style={{
                display: "inline-block",
                marginTop: 22,
                padding: "11px 18px",
                borderRadius: 99,
                font: `500 14px/1 ${sansFont}`,
                textDecoration: "none",
              }}
            >
              Se connecter
            </Link>
          </>
        )}

        {etat === "echec" && (
          <>
            <h1 style={{ margin: "26px 0 0", font: `400 26px/1.2 ${sansFont}`, color: "#16181c" }}>
              Lien inutilisable
            </h1>
            <p style={{ marginTop: 12, font: `400 14px/1.6 ${sansFont}`, color: "#6b7178" }}>
              {message}
            </p>
            <p style={{ marginTop: 10, font: `400 13.5px/1.5 ${sansFont}`, color: "#6b7178" }}>
              Un lien de confirmation ne sert qu&apos;une fois et expire au bout
              de 24 heures. Si votre adresse est déjà confirmée, connectez-vous
              simplement&nbsp;; sinon, demandez un nouveau lien depuis l&apos;écran
              d&apos;inscription.
            </p>
            <Link
              href="/"
              className="ftc-btn-secondary"
              style={{
                display: "inline-block",
                marginTop: 22,
                padding: "11px 18px",
                borderRadius: 99,
                font: `400 14px/1 ${sansFont}`,
                textDecoration: "none",
              }}
            >
              Retour à l&apos;accueil
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
