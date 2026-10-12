import Image from "next/image";

// ARSEO lion and the Nexus wordmark. The official red lion is for light surfaces, the white lion with
// the ARSEO caption for the red brand panel; the files are in public/brand.
export function BrandLockup({ subtitle }: { subtitle?: string }) {
  return (
    <span className="brand-lockup">
      <Image className="brand-logo" src="/brand/arseo-lion-red.png" alt="ARSEO" width={53} height={56} priority />
      <span className="brand-divider" aria-hidden="true" />
      <span className="brand-product-wrap">
        <Image className="brand-product" src="/brand/nexus.png" alt="Nexus" width={640} height={171} priority />
        {subtitle && <small className="brand-subtitle">{subtitle}</small>}
      </span>
    </span>
  );
}

export function NexusWordmark({ className }: { className?: string }) {
  return <Image className={className} src="/brand/nexus.png" alt="Nexus" width={640} height={171} priority />;
}

/** The red ARSEO panel of the sign-in screens. */
export function AuthBrandPanel({ title, text, points }: { title: React.ReactNode; text?: string; points?: string[] }) {
  return (
    <section className="login-brand">
      <Image className="login-brand-logo" src="/brand/arseo-lion-white.png" alt="ARSEO" width={164} height={204} priority />
      <div className="login-brand-copy">
        <h1>{title}</h1>
        {text && <p>{text}</p>}
        {points && points.length > 0 && <ul className="brand-points">{points.map((point) => <li key={point}>{point}</li>)}</ul>}
      </div>
      <small className="login-brand-footer">© ARSEO · Внутренняя система</small>
    </section>
  );
}
