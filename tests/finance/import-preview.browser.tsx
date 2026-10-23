import { createRoot } from "react-dom/client";
import { ImportReview } from "../../src/components/finance/import-review";
createRoot(document.getElementById("root")!).render(<ImportReview payload={{kind:"bank",file_name:"synthetic.txt",file_sha256:"a".repeat(64),problems:[],currency:"KZT",rows:[{rowNumber:12,amount:1234.56}]}}/>);
