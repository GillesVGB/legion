export const planningReasons = {
  pc: 'Mijn pc is kapot.',
  school: 'Ik heb school of moet studeren.',
  training: 'Ik heb training.',
  hobby: 'Ik heb een hobby-afspraak.',
  gym: 'Ik ga naar de gym.',
  work: 'Ik moet werken.',
  illness: 'Ik ben ziek.',
  appointment: 'Ik heb een afspraak.',
};
export const missingAbsenceReason = (value) =>
  /^Afmelding (?:via (?:de|een) rode reactie|aangevraagd via het planningpaneel)/i.test(
    String(value),
  );
// This recognizes stated reasons; it cannot verify whether a member is telling the truth.
// Unclear or negated explanations stay with Lead, rather than being automatically rejected.
export function recognizedAbsenceReason(value) {
  const text = String(value).normalize('NFKC').toLowerCase().trim();
  if (
    missingAbsenceReason(text) ||
    /\b(geen|niet|nooit|grap|zin)\b/.test(text.replace(/kan niet|lukt niet/g, ''))
  )
    return false;
  return (
    /\b(school|studeren|studie|examen|examens|huiswerk|training|trainen|hobby|gym|fitness|sport|werken|werk|ziek|dokter|tandarts|afspraak)\b/.test(
      text,
    ) || /\b(pc|computer|laptop)\b.{0,25}\b(kapot|defect|stuk)\b/.test(text)
  );
}
