import type { Settings } from "../types";
import { IconCheck, IconKey, IconMail, IconSparkles } from "./icons";

interface Step {
  title: string;
  desc: string;
  done: boolean;
}

interface Props {
  settings: Settings | null;
  connected: boolean;
  onGoSettings: () => void;
  onConnect: () => void;
  connecting: boolean;
}

/** Checklist de mise en route affichée tant que l'app n'est pas prête. */
export default function Onboarding({ settings, connected, onGoSettings, onConnect, connecting }: Props) {
  const hasOauth = !!(settings?.googleClientId && settings?.googleClientSecret);
  const hasKey = !!(
    settings?.openrouterApiKey || settings?.nvidiaApiKey || settings?.groqApiKey ||
    settings?.geminiApiKey || settings?.sambanovaApiKey || settings?.cerebrasApiKey
  );

  const steps: Step[] = [
    {
      title: "Identifiants Google OAuth",
      desc: "Client ID + Secret d'un projet Google Cloud avec l'API Gmail activée.",
      done: hasOauth,
    },
    {
      title: "Au moins une clé IA",
      desc: "Gemini, Groq, OpenRouter… toutes gratuites. Plus il y en a, plus le failover est résilient.",
      done: hasKey,
    },
    {
      title: "Connexion Gmail",
      desc: "OAuth 2.0 + PKCE en loopback — vos tokens ne quittent jamais la machine.",
      done: connected,
    },
  ];

  const nextIdx = steps.findIndex((s) => !s.done);

  return (
    <div className="onboarding">
      <div className="onboarding-hero">
        <IconSparkles size={28} className="onboarding-icon" />
        <h2>Triez votre boîte en 3 étapes</h2>
        <p>L'IA catégorise vos mails, applique les labels Gmail et archive ce qui doit l'être.</p>
      </div>

      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.title} className={`step ${s.done ? "done" : ""} ${i === nextIdx ? "next" : ""}`}>
            <span className="step-num">{s.done ? <IconCheck size={14} /> : i + 1}</span>
            <div className="step-body">
              <strong>{s.title}</strong>
              <small>{s.desc}</small>
            </div>
            {i === nextIdx && i < 2 && (
              <button className="primary sm" onClick={onGoSettings}>Configurer</button>
            )}
            {i === nextIdx && i === 2 && (
              <button className="primary sm" onClick={onConnect} disabled={connecting}>
                {connecting ? "Connexion…" : "Connecter Gmail"}
              </button>
            )}
          </li>
        ))}
      </ol>

      <p className="onboarding-foot">
        <IconKey size={13} /> Les clés et tokens sont chiffrés localement (safeStorage) —
        rien n'est envoyé ailleurs qu'à Google et au provider IA choisi.
        <br />
        <IconMail size={13} /> Les mails marqués ★ dans Gmail sont intouchables.
      </p>
    </div>
  );
}
