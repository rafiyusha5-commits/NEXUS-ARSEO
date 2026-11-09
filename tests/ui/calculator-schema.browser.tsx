import React from "react";
import { createRoot } from "react-dom/client";
import { ReferenceImportForm } from "../../src/app/products/import/reference-import-form";

createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: 1120, margin: "auto", padding: 16 }}>
  <p>Синтетический стенд — без Google и базы</p><output id="calls" /><ReferenceImportForm />
</main>);
