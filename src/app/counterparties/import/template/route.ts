export async function GET() {
  const header = "legal_name,short_name,roles,country,tax_id,registration_number,website,default_currency,preferred_locale,min_shelf_life_pct,notes";
  const example = 'Тестовая компания,Тест,"manufacturer|supplier",KZ,000000000000,,,KZT,ru,50,Учебная строка';
  const body = "\uFEFF" + header + "\r\n" + example + "\r\n";
  return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="nexus-counterparties-template.csv"', "Cache-Control": "no-store" } });
}
