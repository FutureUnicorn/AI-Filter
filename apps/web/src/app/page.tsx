import { DOMAIN_LAYER_NAME } from "@signal-audit/domain";

export default function Home() {
  return (
    <main>
      <p className="eyebrow">Signal Audit</p>
      <h1>AI provides evidence. Humans make employment decisions.</h1>
      <p>
        The Next.js delivery shell is connected to the framework-neutral{" "}
        <code>{DOMAIN_LAYER_NAME}</code> package.
      </p>
    </main>
  );
}
