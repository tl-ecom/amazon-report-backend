import { assertEquals } from "jsr:@std/assert@1";
import { volumenZaehlt } from "./masse_lauf.ts";

Deno.test("volumenZaehlt: nur Pakete und Uebergroessen, keine Umschlaege", () => {
  // Rate Card S. 6, Fussnote 4: Umschlaege werden nach Stueckgewicht abgerechnet.
  // Sie als volumengetrieben zu markieren waere ein Hebel, den es nicht gibt.
  assertEquals(volumenZaehlt("StandardParcel"), true);
  assertEquals(volumenZaehlt("SmallParcel3"), true);
  assertEquals(volumenZaehlt("MediumParcel2"), true);
  assertEquals(volumenZaehlt("Kleines Paket"), true);
  assertEquals(volumenZaehlt("StandardEnvelope"), false);
  assertEquals(volumenZaehlt("ExtraLargeEnvelope"), false);
  assertEquals(volumenZaehlt("Großer Umschlag"), false);
  assertEquals(volumenZaehlt(null), false);
});
