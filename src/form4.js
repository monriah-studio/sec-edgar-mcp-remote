// Form 4 (ownership document) XML parser. Ported from monriah-studio/sec-form4-insider-trades,
// extended with all reporting owners, footnote-free values, and buy/sell classification.

export const TX_CODES = {
    P: { label: 'Open-market or private purchase', side: 'buy' },
    S: { label: 'Open-market or private sale', side: 'sell' },
    A: { label: 'Grant or award', side: 'acquire' },
    D: { label: 'Disposition to the issuer', side: 'dispose' },
    F: { label: 'Tax / exercise-price withholding', side: 'dispose' },
    I: { label: 'Discretionary transaction', side: 'other' },
    M: { label: 'Exercise or conversion of derivative (exempt)', side: 'acquire' },
    C: { label: 'Conversion of derivative', side: 'acquire' },
    E: { label: 'Expiration of short derivative', side: 'other' },
    H: { label: 'Expiration of long derivative', side: 'other' },
    O: { label: 'Exercise of out-of-the-money derivative', side: 'acquire' },
    X: { label: 'Exercise of in-the-money derivative', side: 'acquire' },
    G: { label: 'Gift', side: 'other' },
    L: { label: 'Small acquisition', side: 'acquire' },
    W: { label: 'Will or laws of descent', side: 'other' },
    Z: { label: 'Voting trust deposit/withdrawal', side: 'other' },
    J: { label: 'Other acquisition or disposition', side: 'other' },
    K: { label: 'Equity swap', side: 'other' },
    U: { label: 'Tender of shares in change of control', side: 'dispose' },
    V: { label: 'Voluntarily reported earlier', side: 'other' },
};

export const padCik = (cik) => String(cik).replace(/\D/g, '').padStart(10, '0');

function decode(s) {
    return s == null ? s : String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").trim();
}
function tagText(xml, tag) {
    const m = String(xml || '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1].trim() : null;
}
function valueOf(block, tag) {
    const inner = tagText(block, tag);
    if (inner == null) return null;
    const v = tagText(inner, 'value');
    if (v != null) return decode(v);
    const cleaned = inner.replace(/<[^>]+>/g, '').trim();
    return cleaned ? decode(cleaned) : null;
}
function allBlocks(xml, tag) {
    return [...String(xml || '').matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1]);
}
const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[,$]/g, ''));
    return Number.isFinite(n) ? n : null;
};
const flag = (rel, tag) => {
    const v = (tagText(rel, tag) || '').toLowerCase();
    return v === '1' || v === 'true';
};

/** Extract the <ownershipDocument> XML from a raw .xml file or a full-submission .txt. */
export function extractOwnershipXml(text) {
    if (!text) return null;
    const m = text.match(/<ownershipDocument[\s\S]*?<\/ownershipDocument>/i);
    return m ? m[0] : null;
}

export function roleOf(o) {
    const parts = [];
    if (o.officerTitle) parts.push(o.officerTitle);
    else if (o.isOfficer) parts.push('Officer');
    if (o.isDirector) parts.push('Director');
    if (o.isTenPercentOwner) parts.push('10% Owner');
    if (o.isOther && o.otherText) parts.push(o.otherText);
    return parts.join(', ') || null;
}

export function parseForm4(xmlRaw, meta = {}) {
    const xml = extractOwnershipXml(xmlRaw);
    if (!xml) return null;
    const issuer = tagText(xml, 'issuer') || '';
    const issuerName = decode(tagText(issuer, 'issuerName')) || meta.issuerName || null;
    let ticker = (decode(tagText(issuer, 'issuerTradingSymbol')) || meta.ticker || '').toUpperCase() || null;
    if (ticker && /^(NONE|N\/A|NA|-+)$/.test(ticker)) ticker = null;
    const issuerCikRaw = tagText(issuer, 'issuerCik') || meta.issuerCik;
    const documentType = tagText(xml, 'documentType');
    const periodOfReport = tagText(xml, 'periodOfReport');
    const is10b51 = /<aff10b5One>\s*(true|1)\s*<\/aff10b5One>/i.test(xml);

    const owners = allBlocks(xml, 'reportingOwner').map((o) => {
        const id = tagText(o, 'reportingOwnerId') || o;
        const rel = tagText(o, 'reportingOwnerRelationship') || '';
        const owner = {
            name: decode(tagText(id, 'rptOwnerName')),
            cik: tagText(id, 'rptOwnerCik') ? padCik(tagText(id, 'rptOwnerCik')) : null,
            isDirector: flag(rel, 'isDirector'),
            isOfficer: flag(rel, 'isOfficer'),
            isTenPercentOwner: flag(rel, 'isTenPercentOwner'),
            isOther: flag(rel, 'isOther'),
            officerTitle: decode(tagText(rel, 'officerTitle')),
            otherText: decode(tagText(rel, 'otherText')),
        };
        owner.role = roleOf(owner);
        return owner;
    });
    const primary = owners[0] || {};

    const transactions = [];
    const pushTx = (block, isDerivative) => {
        const code = (tagText(tagText(block, 'transactionCoding') || '', 'transactionCode') || '').toUpperCase();
        if (!code) return;
        const shares = num(valueOf(block, 'transactionShares'));
        const price = num(valueOf(block, 'transactionPricePerShare'));
        const ad = valueOf(block, 'transactionAcquiredDisposedCode');
        transactions.push({
            transactionDate: valueOf(block, 'transactionDate'),
            transactionCode: code,
            transactionType: TX_CODES[code]?.label || 'Other',
            side: TX_CODES[code]?.side || 'other',
            isOpenMarket: code === 'P' || code === 'S',
            acquiredDisposed: ad,
            shares,
            pricePerShare: price,
            totalValue: shares != null && price != null ? Math.round(shares * price * 100) / 100 : null,
            sharesOwnedAfter: num(valueOf(block, 'sharesOwnedFollowingTransaction')),
            directOrIndirect: valueOf(block, 'directOrIndirectOwnership'),
            securityTitle: valueOf(block, 'securityTitle'),
            isDerivative,
            underlyingShares: isDerivative ? num(valueOf(block, 'underlyingSecurityShares')) : null,
            exercisePrice: isDerivative ? num(valueOf(block, 'conversionOrExercisePrice')) : null,
        });
    };
    for (const b of allBlocks(xml, 'nonDerivativeTransaction')) pushTx(b, false);
    for (const b of allBlocks(xml, 'derivativeTransaction')) pushTx(b, true);

    return {
        accessionNumber: meta.accessionNumber || null,
        formType: documentType || meta.form || '4',
        filingDate: meta.filingDate || null,
        periodOfReport,
        issuer: { name: issuerName, ticker, cik: issuerCikRaw ? padCik(issuerCikRaw) : null },
        insider: { name: primary.name || null, cik: primary.cik || null, role: primary.role || null, officerTitle: primary.officerTitle || null, isDirector: !!primary.isDirector, isOfficer: !!primary.isOfficer, isTenPercentOwner: !!primary.isTenPercentOwner },
        reportingOwners: owners,
        is10b51Plan: is10b51,
        transactions,
        filingUrl: meta.filingUrl || null,
        indexUrl: meta.indexUrl || null,
    };
}

/** Flatten a parsed filing into one row per transaction. */
export function flatten(f) {
    if (!f) return [];
    return f.transactions.map((t) => ({
        ticker: f.issuer.ticker,
        issuerName: f.issuer.name,
        issuerCik: f.issuer.cik,
        insiderName: f.insider.name,
        insiderCik: f.insider.cik,
        insiderRole: f.insider.role,
        isDirector: f.insider.isDirector,
        isOfficer: f.insider.isOfficer,
        isTenPercentOwner: f.insider.isTenPercentOwner,
        ...t,
        is10b51Plan: f.is10b51Plan,
        formType: f.formType,
        accessionNumber: f.accessionNumber,
        filingDate: f.filingDate,
        filingUrl: f.filingUrl,
    }));
}
