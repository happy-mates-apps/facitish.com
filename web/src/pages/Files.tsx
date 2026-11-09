import { FileBrowser } from "./FileBrowser";
import { PageHeader } from "../ui";

export default function Files() {
  return (
    <div className="page">
      <PageHeader eyebrow="Object Storage" title="Filer">
        Dine egne filer ligger under Mine filer. Fælles er projektfiler, som alle brugere og AI-chatten kan læse og gemme.
        Download sker via et link, der kun virker i få minutter.
      </PageHeader>
      <FileBrowser />
    </div>
  );
}
