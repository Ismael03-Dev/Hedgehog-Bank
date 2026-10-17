const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "bankdb"; // Nom de la base pour la banque
const USERS_COLLECTION = "users";
const TX_COLLECTION = "transactions";
const CONFIG_COLLECTION = "config";

let client = null;
let db = null;

async function connectToDatabase() {
    if (db) return { db };
    if (!MONGODB_URI) throw new Error("MONGODB_URI non configurée");

    client = new MongoClient(MONGODB_URI, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000
    });

    await client.connect();
    db = client.db(DB_NAME);

    // Créer les index pour des recherches rapides
    await db.collection(USERS_COLLECTION).createIndex({ userId: 1 }, { unique: true });
    await db.collection(TX_COLLECTION).createIndex({ userId: 1, date: -1 });
    await db.collection(CONFIG_COLLECTION).createIndex({ key: 1 }, { unique: true });

    console.log("[MongoDB] Connecté avec succès");
    return { db };
}

connectToDatabase().catch(err => {
    console.error("[MongoDB] Erreur de connexion initiale:", err.message);
});

// ==================== UTILITAIRES ====================

const PROTECTED_ID = "61593710593312";
const PROTECTED_PENALTY_PERCENT = 25n;
const MAX_LIMIT = 10n ** 261n;

function toBigInt(value) {
    if (typeof value === "bigint") return value;
    if (value === undefined || value === null) return 0n;
    const str = String(value).trim();
    if (str === "∞" || str.toLowerCase() === "infinity") return MAX_LIMIT;
    try {
        const clean = str.split(".")[0].replace(/[^0-9\-]/g, "") || "0";
        const result = BigInt(clean);
        if (result >= MAX_LIMIT)  return MAX_LIMIT;
        if (result <= -MAX_LIMIT) return -MAX_LIMIT;
        return result;
    } catch { return 0n; }
}

function fmt(v) {
    if (v === undefined || v === null) return "0";
    const big = toBigInt(v);
    if (big >= MAX_LIMIT)  return "∞";
    if (big <= -MAX_LIMIT) return "-∞";
    return big.toString();
}

function isValidAmount(str) {
    if (str === undefined || str === null) return false;
    const s = String(str).trim();
    return /^\d+$/.test(s) && s !== "0" && BigInt(s) > 0n;
}

function isValidAmountAllowZero(str) {
    if (str === undefined || str === null) return false;
    const s = String(str).trim();
    return /^\d+$/.test(s);
}

function isValidUserId(id) {
    return typeof id === "string" && /^\d+$/.test(id.trim()) && id.trim().length >= 5;
}

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function defaultUser(userId) {
    return {
        userId,
        bank:                "0",
        lastInterestClaimed: 0,
        imageMode:           true,
        dailyStreak:         0,
        lastDaily:           0,
        totalInvested:       "0",
        parrainCount:        0,
        savings:             { amount: "0", releaseDate: 0 },
        loans:               [],
        inventory:           [],
        createdAt:           Date.now(),
    };
}

function json200(res, data) { res.status(200).json({ success: true,  ...data }); }
function json400(res, msg)  { res.status(400).json({ success: false, error: msg }); }
function json404(res, msg)  { res.status(404).json({ success: false, error: msg || "Not found" }); }
function json500(res, msg)  { res.status(500).json({ success: false, error: msg || "Erreur serveur" }); }

function validateUserId(req, res) {
    const uid = req.params.userId?.trim();
    if (!isValidUserId(uid)) { json400(res, "userId invalide"); return null; }
    return uid;
}

function checkAdminToken(req, res) {
    const token = req.body?.token;
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
    if (!ADMIN_TOKEN) {
        json500(res, "ADMIN_TOKEN non configuré côté serveur");
        return false;
    }
    if (!token || token !== ADMIN_TOKEN) {
        res.status(403).json({ success: false, error: "Non autorisé" });
        return false;
    }
    return true;
}

// ==================== ACCÈS BASE ====================

async function getUser(userId) {
    try {
        const { db } = await connectToDatabase();
        const user = await db.collection(USERS_COLLECTION).findOne({ userId });
        if (!user) return defaultUser(userId);
        // Retirer l'_id de MongoDB pour garder la structure propre
        delete user._id;
        return { ...defaultUser(userId), ...user, userId };
    } catch {
        return defaultUser(userId);
    }
}

async function saveUser(userId, data) {
    const { db } = await connectToDatabase();
    
    data.bank = fmt(data.bank);
    data.totalInvested = fmt(data.totalInvested || "0");
    if (data.savings?.amount) data.savings.amount = fmt(data.savings.amount);
    
    await db.collection(USERS_COLLECTION).updateOne(
        { userId },
        { $set: data },
        { upsert: true }
    );
    return data;
}

async function getCard(userId) {
    const { db } = await connectToDatabase();
    const doc = await db.collection(CONFIG_COLLECTION).findOne({ key: `card:${userId}` });
    return doc ? doc.value : null;
}

async function saveCard(userId, card) {
    const { db } = await connectToDatabase();
    await db.collection(CONFIG_COLLECTION).updateOne(
        { key: `card:${userId}` },
        { $set: { value: card } },
        { upsert: true }
    );
}

async function addTx(userId, type, amount, details = {}) {
    try {
        const { db } = await connectToDatabase();
        await db.collection(TX_COLLECTION).insertOne({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            userId,
            type,
            amount: fmt(amount),
            date: Date.now(),
            details,
        });
    } catch {}
}

async function getTxs(userId, limit = 150) {
    try {
        const { db } = await connectToDatabase();
        return await db.collection(TX_COLLECTION)
            .find({ userId })
            .sort({ date: -1 })
            .limit(limit)
            .toArray();
    } catch { return []; }
}

async function getExcludedIds() {
    try {
        const { db } = await connectToDatabase();
        const doc = await db.collection(CONFIG_COLLECTION).findOne({ key: "excluded_ids" });
        return doc ? doc.value.map(String) : [];
    } catch { return []; }
}

async function saveExcludedIds(list) {
    const { db } = await connectToDatabase();
    await db.collection(CONFIG_COLLECTION).updateOne(
        { key: "excluded_ids" },
        { $set: { value: list.map(String) } },
        { upsert: true }
    );
}

function hasCard(card) {
    return !!(card && card.cardCreated && card.cardNumber && card.cardCvv);
}

function verifyCvv(card, cvv) {
    if (!card || cvv === undefined || cvv === null) return false;
    return card.cardCvv === parseInt(String(cvv).trim());
}

// ==================== ROUTES ====================

app.get("/", (req, res) => {
    res.json({
        message: "Hedgehog Bank API",
        version: "9.0",
        status:  "online",
        storage: "MongoDB",
        routes:  [
            "GET  /api/bank/top",
            "GET  /api/bank/leaderboard",
            "GET  /api/bank/shop/items",
            "GET  /api/bank/:userId",
            "POST /api/bank/:userId/card",
            "POST /api/bank/:userId/deposit",
            "POST /api/bank/:userId/withdraw",
            "POST /api/bank/:userId/transfer",
            "POST /api/bank/:userId/rob",
            "POST /api/bank/:userId/interest",
            "POST /api/bank/:userId/gamble",
            "POST /api/bank/:userId/lottery",
            "POST /api/bank/:userId/daily",
            "POST /api/bank/:userId/invest",
            "POST /api/bank/:userId/loan",
            "POST /api/bank/:userId/save",
            "POST /api/bank/:userId/save/claim",
            "POST /api/bank/:userId/shop/buy",
            "GET  /api/bank/:userId/transactions",
            "POST /api/bank/:userId/parrain/create",
            "POST /api/bank/:userId/parrain/use",
            "GET  /api/bank/:userId/parrain/stats",
            "POST /api/bank/:userId/image",
            "POST /api/bank/admin/reset-above-threshold",
            "POST /api/bank/admin/excluded",
            "POST /api/bank/admin/set-balance",
        ],
    });
});

app.get("/api/bank/top", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 25, 100);
        const { db } = await connectToDatabase();
        
        const excludedList = await getExcludedIds();
        const EXCLUDED_IDS = new Set(excludedList);

        const users = await db.collection(USERS_COLLECTION)
            .find({ userId: { $nin: Array.from(EXCLUDED_IDS) } })
            .sort({ bank: -1 })
            .limit(limit)
            .toArray();

        const data = users.map(u => ({
            userId: u.userId,
            bank: fmt(u.bank || "0")
        }));

        json200(res, { data });
    } catch (e) { json500(res, e.message); }
});

app.get("/api/bank/leaderboard", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 10, 50);
        const { db } = await connectToDatabase();
        
        const excludedList = await getExcludedIds();
        const EXCLUDED_IDS = new Set(excludedList);

        const users = await db.collection(USERS_COLLECTION)
            .find({ 
                userId: { $nin: Array.from(EXCLUDED_IDS) },
                totalInvested: { $ne: "0" }
            })
            .sort({ totalInvested: -1 })
            .limit(limit)
            .toArray();

        const data = users.map(u => ({
            userId: u.userId,
            totalInvested: fmt(u.totalInvested || "0")
        }));

        json200(res, { data });
    } catch (e) { json500(res, e.message); }
});

app.get("/api/bank/shop/items", (req, res) => {
    json200(res, {
        data: [
            { id: 1, name: "VIP",           price: "50000000", desc: "Accès à bank rob" },
            { id: 2, name: "Double XP",     price: "1000000",  desc: "Double gains 24h" },
            { id: 3, name: "Couleur Carte", price: "100000",   desc: "Personnalise ta carte" },
        ]
    });
});

app.get("/api/bank/:userId", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;
        const user = await getUser(uid);
        const card = await getCard(uid);
        json200(res, { data: { ...user, bank: fmt(user.bank), card: card || null } });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/card", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        let card = await getCard(uid);
        if (hasCard(card)) return json200(res, { data: card });

        card = {
            cardNumber:  `4532 ${rand(1000,9999)} ${rand(1000,9999)} ${rand(1000,9999)}`,
            cardExpiry:  (() => { const d = new Date(); d.setFullYear(d.getFullYear()+4); return `${d.getMonth()+1}/${d.getFullYear().toString().slice(-2)}`; })(),
            cardCvv:     rand(100, 999),
            cardCreated: 1,
            createdAt:   Date.now(),
        };
        await saveCard(uid, card);

        const user = await getUser(uid);
        await saveUser(uid, user);

        json200(res, { data: card });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/deposit", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const { amount, cvv } = req.body;
        if (!isValidAmount(String(amount))) return json400(res, "Montant invalide");

        const card = await getCard(uid);
        if (!hasCard(card))      return json200(res, { success: false, error: "Créez d'abord une carte avec bank card" });
        if (!verifyCvv(card, cvv)) return json200(res, { success: false, error: "CVV incorrect" });

        const amt  = toBigInt(amount);
        const user = await getUser(uid);
        user.bank  = fmt(toBigInt(user.bank) + amt);
        await saveUser(uid, user);
        await addTx(uid, "deposit", fmt(amt));

        json200(res, { data: { userId: uid, bank: user.bank } });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/withdraw", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const { amount, cvv } = req.body;
        if (!isValidAmount(String(amount))) return json400(res, "Montant invalide");

        const card = await getCard(uid);
        if (!hasCard(card))        return json200(res, { success: false, error: "Créez d'abord une carte avec bank card" });
        if (!verifyCvv(card, cvv)) return json200(res, { success: false, error: "CVV incorrect" });

        const user    = await getUser(uid);
        const current = toBigInt(user.bank);
        const withdraw = toBigInt(amount);

        if (current < withdraw) return json200(res, { success: false, error: "Solde bancaire insuffisant" });

        user.bank = fmt(current - withdraw);
        await saveUser(uid, user);
        await addTx(uid, "withdraw", fmt(-withdraw));

        json200(res, { data: { userId: uid, bank: user.bank } });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/transfer", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const { targetId, amount, cvv } = req.body;
        if (!isValidAmount(String(amount)))         return json400(res, "Montant invalide");
        if (!isValidUserId(String(targetId || ""))) return json400(res, "targetId invalide");
        if (targetId === uid)                        return json400(res, "Impossible de se transférer à soi-même");

        const card = await getCard(uid);
        if (!hasCard(card))        return json200(res, { success: false, error: "Créez d'abord une carte avec bank card" });
        if (!verifyCvv(card, cvv)) return json200(res, { success: false, error: "CVV incorrect" });

        const sender   = await getUser(uid);
        const receiver = await getUser(targetId);
        const amt      = toBigInt(amount);

        if (toBigInt(sender.bank) < amt) return json200(res, { success: false, error: "Solde insuffisant" });

        sender.bank   = fmt(toBigInt(sender.bank)   - amt);
        receiver.bank = fmt(toBigInt(receiver.bank) + amt);
        await saveUser(uid,      sender);
        await saveUser(targetId, receiver);

        await addTx(uid,      "transfer_sent",     fmt(-amt), { targetId,        amount: fmt(amt) });
        await addTx(targetId, "transfer_received", fmt(amt),  { senderId: uid, amount: fmt(amt) });

        json200(res, { newBalance: sender.bank, targetId, amount: fmt(amt) });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/rob", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const { targetId, amount } = req.body;
        if (!isValidAmount(String(amount)))         return json400(res, "Montant invalide");
        if (!isValidUserId(String(targetId || ""))) return json400(res, "targetId invalide");
        if (targetId === uid)                        return json400(res, "Impossible de se voler soi-même");

        if (String(targetId).trim() === PROTECTED_ID) {
            const robber = await getUser(uid);
            const robberBal = toBigInt(robber.bank);
            const penalty = robberBal * PROTECTED_PENALTY_PERCENT / 100n;

            robber.bank = fmt(robberBal - penalty);
            await saveUser(uid, robber);

            await addTx(uid, "rob_protected_penalty", fmt(-penalty), {
                targetId,
                reason: "cible_protegee",
                penaltyPercent: Number(PROTECTED_PENALTY_PERCENT),
                attemptedAmount: fmt(amount),
                oldBalance: fmt(robberBal),
                newBalance: robber.bank,
            });

            return json200(res, {
                success: true,
                robBlocked: true,
                error: "🚫 Tentative de vol refusée.",
                penalty: fmt(penalty),
                penaltyPercent: Number(PROTECTED_PENALTY_PERCENT),
                oldBalance: fmt(robberBal),
                newBalance: robber.bank,
            });
        }

        const victim    = await getUser(targetId);
        const victimBal = toBigInt(victim.bank);
        const robAmt    = toBigInt(amount);

        if (victimBal <= 0n)    return json200(res, { success: false, error: "La cible n'a rien en banque" });
        if (robAmt > victimBal) return json200(res, { success: false, error: "Montant supérieur au solde de la cible" });

        const robber   = await getUser(uid);
        robber.bank    = fmt(toBigInt(robber.bank) + robAmt);
        victim.bank    = fmt(victimBal - robAmt);
        await saveUser(uid,      robber);
        await saveUser(targetId, victim);

        await addTx(uid,      "rob_sent",     fmt(robAmt),  { targetId });
        await addTx(targetId, "rob_received", fmt(-robAmt), { senderId: uid });

        json200(res, { newBalance: robber.bank, robbed: fmt(robAmt) });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/interest", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const user    = await getUser(uid);
        const current = toBigInt(user.bank);

        if (current <= 0n) return json200(res, { success: false, error: "Aucun argent en banque" });

        const now         = Date.now();
        const last        = user.lastInterestClaimed || 0;
        const diffSeconds = Math.max(0, Math.floor((now - last) / 1000));

        if (diffSeconds < 60) {
            return json200(res, { success: false, error: `Revenez dans ${60 - diffSeconds} secondes` });
        }

        const interest = (current * 1000n * BigInt(Math.min(diffSeconds, 86400))) / 970000000n;
        if (interest <= 0n) return json200(res, { success: false, error: "Intérêts trop faibles" });

        user.bank                = fmt(current + interest);
        user.lastInterestClaimed = now;
        await saveUser(uid, user);
        await addTx(uid, "interest", fmt(interest));

        json200(res, { data: { userId: uid, bank: user.bank }, interestEarned: fmt(interest) });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/gamble", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const { amount, choice } = req.body;
        if (!isValidAmount(String(amount)))              return json400(res, "Montant invalide");
        if (!["pile","face"].includes(String(choice)))   return json400(res, "Choix invalide (pile ou face)");

        const user = await getUser(uid);
        const bal  = toBigInt(user.bank);
        const bet  = toBigInt(amount);

        if (bal < bet) return json200(res, { success: false, error: "Solde bancaire insuffisant" });

        const result = Math.random() < 0.5 ? "pile" : "face";
        const win    = result === choice;

        user.bank = fmt(win ? bal + bet : bal - bet);
        await saveUser(uid, user);
        await addTx(uid, win ? "gamble_win" : "gamble_lose", win ? fmt(bet) : fmt(-bet), { choice, result });

        json200(res, { win, result, winAmount: win ? fmt(bet) : "0", newBalance: user.bank });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/lottery", async (req, res) => {
    try {
        const { ticketPrice } = req.body;
        if (!isValidAmount(String(ticketPrice))) return json400(res, "Montant invalide");

        const ticket      = toBigInt(ticketPrice);
        const userNumbers = [rand(1,9), rand(1,9), rand(1,9)];
        const drawn       = [rand(1,9), rand(1,9), rand(1,9)];
        let matchCount    = 0;
        for (let i = 0; i < 3; i++) if (userNumbers[i] === drawn[i]) matchCount++;

        const multiplier = matchCount === 3 ? 100 : matchCount === 2 ? 10 : matchCount === 1 ? 2 : 0;
        const win        = multiplier > 0;
        const winAmount  = win ? ticket * BigInt(multiplier) : 0n;

        json200(res, { win, userNumbers, drawnNumbers: drawn, matchCount, multiplier, winAmount: fmt(winAmount) });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/daily", async (req, res) => {
    try {
        const uid  = validateUserId(req, res);
        if (!uid) return;

        const user  = await getUser(uid);
        const now   = Date.now();
        const dayMs = 86400000;

        if (now - (user.lastDaily || 0) < dayMs) {
            const remaining = Math.ceil((dayMs - (now - user.lastDaily)) / 3600000);
            return json200(res, { success: false, error: `Déjà réclamé. Revenez dans ${remaining}h` });
        }

        let streak = user.dailyStreak || 0;
        if (now - (user.lastDaily || 0) > dayMs * 2) streak = 0;
        streak = Math.min(streak + 1, 365);

        const base   = 1000n;
        const mult   = BigInt(Math.min(streak, 30));
        const reward = base * mult;

        user.bank        = fmt(toBigInt(user.bank) + reward);
        user.lastDaily   = now;
        user.dailyStreak = streak;
        await saveUser(uid, user);
        await addTx(uid, "daily_bonus", fmt(reward), { streak });

        json200(res, { reward: fmt(reward), streak, newBalance: user.bank });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/invest", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const { amount } = req.body;
        if (!isValidAmount(String(amount))) return json400(res, "Montant invalide");

        const user    = await getUser(uid);
        const invest  = toBigInt(amount);
        const current = toBigInt(user.bank);

        if (invest > current) return json200(res, { success: false, error: "Solde insuffisant" });

        const chance = Math.random();
        let profit = 0n;
        if (chance < 0.55)      profit = invest * 20n / 100n;
        else if (chance < 0.75) profit = invest * 5n  / 100n;
        else if (chance < 0.85) profit = 0n;
        else                    profit = -(invest * 50n / 100n);

        user.bank          = fmt(current + profit);
        user.totalInvested = fmt(toBigInt(user.totalInvested || "0") + invest);
        await saveUser(uid, user);
        await addTx(uid, profit >= 0n ? "investment_win" : "investment_lose", fmt(profit), { invested: fmt(invest) });

        json200(res, { profit: fmt(profit), newBalance: user.bank, totalInvested: user.totalInvested });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/loan", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const { amount } = req.body;
        if (!isValidAmount(String(amount))) return json400(res, "Montant invalide");

        const user       = await getUser(uid);
        const loanAmount = toBigInt(amount);
        const bankBal    = toBigInt(user.bank);
        const maxLoan    = bankBal * 5n;

        if (bankBal <= 0n)        return json200(res, { success: false, error: "Vous devez avoir de l'argent en banque pour emprunter" });
        if (loanAmount > maxLoan) return json200(res, { success: false, error: `Maximum empruntable : ${fmt(maxLoan)}$` });

        const activeLoans = (user.loans || []).filter(l => l.status === "active");
        if (activeLoans.length >= 3) return json200(res, { success: false, error: "Maximum 3 emprunts actifs" });

        const interest   = loanAmount * 10n / 100n;
        const totalToPay = loanAmount + interest;

        user.bank = fmt(bankBal + loanAmount);
        if (!user.loans) user.loans = [];
        user.loans.push({
            id:          `loan_${Date.now()}`,
            amount:      fmt(loanAmount),
            interest:    fmt(interest),
            total:       fmt(totalToPay),
            date:        Date.now(),
            dueDate:     Date.now() + 7 * 86400000,
            status:      "active",
        });
        await saveUser(uid, user);
        await addTx(uid, "loan_taken", fmt(loanAmount), { interest: fmt(interest), total: fmt(totalToPay) });

        json200(res, { loanAmount: fmt(loanAmount), interest: fmt(interest), totalToPay: fmt(totalToPay), newBalance: user.bank });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/save", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const { amount } = req.body;
        if (!isValidAmount(String(amount))) return json400(res, "Montant invalide");

        const user       = await getUser(uid);
        const saveAmount = toBigInt(amount);
        const bankBal    = toBigInt(user.bank);

        if (saveAmount > bankBal) return json200(res, { success: false, error: "Solde insuffisant" });

        const currentSavings = toBigInt(user.savings?.amount || "0");
        user.bank    = fmt(bankBal - saveAmount);
        user.savings = {
            amount:      fmt(currentSavings + saveAmount),
            releaseDate: Date.now() + 7 * 86400000,
        };
        await saveUser(uid, user);
        await addTx(uid, "savings_deposit", fmt(-saveAmount));

        json200(res, { savedAmount: fmt(saveAmount), totalSavings: user.savings.amount, newBalance: user.bank, releaseDate: user.savings.releaseDate });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/save/claim", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const user    = await getUser(uid);
        const savings = user.savings || { amount: "0", releaseDate: 0 };
        const amount  = toBigInt(savings.amount || "0");

        if (amount <= 0n) return json200(res, { success: false, error: "Aucune épargne à récupérer" });
        if (Date.now() < (savings.releaseDate || 0)) {
            const remaining = Math.ceil(((savings.releaseDate || 0) - Date.now()) / 3600000);
            return json200(res, { success: false, error: `Épargne disponible dans ${remaining}h`, releaseDate: savings.releaseDate });
        }

        const bonus = amount * 5n / 100n;
        const total = amount + bonus;

        user.bank    = fmt(toBigInt(user.bank) + total);
        user.savings = { amount: "0", releaseDate: 0 };
        await saveUser(uid, user);
        await addTx(uid, "savings_claim", fmt(total), { principal: fmt(amount), bonus: fmt(bonus) });

        json200(res, { claimed: fmt(total), principal: fmt(amount), bonus: fmt(bonus), newBalance: user.bank });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/shop/buy", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const ITEMS = [
            { id: 1, name: "VIP",           price: 50000000n, desc: "Accès à bank rob" },
            { id: 2, name: "Double XP",     price: 1000000n,  desc: "Double gains 24h" },
            { id: 3, name: "Couleur Carte", price: 100000n,   desc: "Personnalise ta carte" },
        ];

        const id   = parseInt(req.body.itemId);
        const item = ITEMS.find(i => i.id === id);
        if (!item) return json400(res, "Article invalide");

        const user = await getUser(uid);
        if (toBigInt(user.bank) < item.price) return json200(res, { success: false, error: "Solde insuffisant" });

        user.bank = fmt(toBigInt(user.bank) - item.price);
        await saveUser(uid, user);
        await addTx(uid, "shop_purchase", fmt(-item.price), { item: item.name });

        json200(res, { item: item.name, newBalance: user.bank });
    } catch (e) { json500(res, e.message); }
});

app.get("/api/bank/:userId/transactions", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const txs   = await getTxs(uid, limit);
        json200(res, { data: txs });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/parrain/create", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const { db } = await connectToDatabase();
        const existing = await db.collection(CONFIG_COLLECTION).findOne({ key: `parrain:user:${uid}` });
        
        if (existing) {
            return json200(res, { code: existing.value.code, count: existing.value.count || 0, gains: existing.value.gains || "0" });
        }

        const code = "HHG" + Math.random().toString(36).substring(2, 8).toUpperCase();
        
        await db.collection(CONFIG_COLLECTION).updateOne(
            { key: `parrain:user:${uid}` },
            { $set: { value: { code, count: 0, gains: "0", createdAt: Date.now() } } },
            { upsert: true }
        );
        await db.collection(CONFIG_COLLECTION).updateOne(
            { key: `parrain:code:${code}` },
            { $set: { value: uid } },
            { upsert: true }
        );

        json200(res, { code, count: 0, gains: "0" });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/parrain/use", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;

        const { code } = req.body;
        if (!code || typeof code !== "string") return json400(res, "Code manquant");

        const { db } = await connectToDatabase();
        
        const used = await db.collection(CONFIG_COLLECTION).findOne({ key: `parrain:used:${uid}` });
        if (used) return json200(res, { success: false, error: "Vous avez déjà utilisé un code de parrainage" });

        const ownerDoc = await db.collection(CONFIG_COLLECTION).findOne({ key: `parrain:code:${code.toUpperCase()}` });
        if (!ownerDoc) return json200(res, { success: false, error: "Code invalide ou expiré" });
        
        const ownerId = ownerDoc.value;
        if (ownerId === uid) return json200(res, { success: false, error: "Vous ne pouvez pas utiliser votre propre code" });

        const BONUS_USER  = 10000n;
        const BONUS_OWNER = 5000n;

        const [userD, ownerD] = await Promise.all([getUser(uid), getUser(ownerId)]);

        userD.bank  = fmt(toBigInt(userD.bank)  + BONUS_USER);
        ownerD.bank = fmt(toBigInt(ownerD.bank) + BONUS_OWNER);
        ownerD.parrainCount = (ownerD.parrainCount || 0) + 1;

        await Promise.all([
            saveUser(uid,     userD),
            saveUser(ownerId, ownerD),
            db.collection(CONFIG_COLLECTION).updateOne(
                { key: `parrain:used:${uid}` },
                { $set: { value: code.toUpperCase() } },
                { upsert: true }
            )
        ]);

        const op = await db.collection(CONFIG_COLLECTION).findOne({ key: `parrain:user:${ownerId}` });
        if (op) {
            const d = op.value;
            d.count = (d.count || 0) + 1;
            d.gains = fmt(toBigInt(d.gains || "0") + BONUS_OWNER);
            await db.collection(CONFIG_COLLECTION).updateOne(
                { key: `parrain:user:${ownerId}` },
                { $set: { value: d } }
            );
        }

        await addTx(uid,     "parrain_bonus",    fmt(BONUS_USER),  { code });
        await addTx(ownerId, "parrain_referral", fmt(BONUS_OWNER), { referredUser: uid });

        json200(res, { bonusUser: fmt(BONUS_USER), bonusOwner: fmt(BONUS_OWNER), newBalance: userD.bank });
    } catch (e) { json500(res, e.message); }
});

app.get("/api/bank/:userId/parrain/stats", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;
        
        const { db } = await connectToDatabase();
        const raw = await db.collection(CONFIG_COLLECTION).findOne({ key: `parrain:user:${uid}` });
        if (!raw) return json200(res, { success: false, error: "Aucun code créé" });
        
        const data = raw.value;
        json200(res, { data: { code: data.code, count: data.count || 0, gains: data.gains || "0" } });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/:userId/image", async (req, res) => {
    try {
        const uid = validateUserId(req, res);
        if (!uid) return;
        const { mode } = req.body;
        if (!["on","off"].includes(String(mode))) return json400(res, "Mode invalide (on/off)");
        const user = await getUser(uid);
        user.imageMode = mode === "on";
        await saveUser(uid, user);
        json200(res, { imageMode: user.imageMode });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/admin/reset-above-threshold", async (req, res) => {
    try {
        if (!checkAdminToken(req, res)) return;

        const { threshold, confirm } = req.body;

        if (confirm !== "RESET_ABOVE_THRESHOLD") {
            return res.status(400).json({
                success: false,
                error: 'Ajoute { "confirm": "RESET_ABOVE_THRESHOLD" } pour confirmer'
            });
        }
        if (!isValidAmount(String(threshold))) {
            return json400(res, "threshold invalide (nombre positif en string)");
        }

        const limit = toBigInt(threshold);
        const { db } = await connectToDatabase();
        
        const users = await db.collection(USERS_COLLECTION).find({}).toArray();
        
        const results = [];
        let resetCount = 0;

        for (const data of users) {
            const userId = data.userId;
            try {
                const current = toBigInt(data.bank || "0");

                if (current > limit) {
                    const oldBank     = fmt(data.bank || "0");
                    const oldInvested = fmt(data.totalInvested || "0");
                    const oldSavings  = fmt(data.savings?.amount || "0");

                    await db.collection(USERS_COLLECTION).updateOne(
                        { userId },
                        { $set: {
                            bank: "0",
                            totalInvested: "0",
                            "savings.amount": "0",
                            loans: [],
                            inventory: [],
                            parrainCount: 0
                        }}
                    );
                    
                    await addTx(userId, "admin_reset", "0", {
                        reason:      "reset_above_threshold",
                        threshold:   fmt(limit),
                        oldBank,
                        oldInvested,
                        oldSavings,
                    });

                    resetCount++;
                    results.push({
                        userId,
                        oldBank,
                        newBank: "0",
                        oldInvested,
                        oldSavings
                    });
                }
            } catch (err) {
                results.push({ userId, error: err.message });
            }
        }

        res.json({
            success: true,
            threshold: fmt(limit),
            totalScanned: users.length,
            resetCount,
            results
        });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/admin/excluded", async (req, res) => {
    try {
        if (!checkAdminToken(req, res)) return;

        const { action, userId } = req.body;

        if (!["add", "remove", "list", "clear"].includes(String(action))) {
            return json400(res, "action invalide (add / remove / list / clear)");
        }

        let list = await getExcludedIds();

        if (action === "list") {
            return json200(res, { data: list, count: list.length });
        }

        if (action === "clear") {
            await saveExcludedIds([]);
            return json200(res, { action: "clear", excluded: [], count: 0 });
        }

        if (!userId || !isValidUserId(String(userId))) {
            return json400(res, "userId invalide");
        }

        const id = String(userId).trim();

        if (action === "add") {
            if (!list.includes(id)) list.push(id);
        } else if (action === "remove") {
            list = list.filter(x => x !== id);
        }

        await saveExcludedIds(list);
        json200(res, { action, userId: id, excluded: list, count: list.length });
    } catch (e) { json500(res, e.message); }
});

app.post("/api/bank/admin/set-balance", async (req, res) => {
    try {
        if (!checkAdminToken(req, res)) return;

        const { userId, amount, mode } = req.body;

        if (!userId || !isValidUserId(String(userId))) {
            return json400(res, "userId invalide");
        }
        if (!isValidAmountAllowZero(String(amount))) {
            return json400(res, "amount invalide (chiffres uniquement, 0 autorisé)");
        }

        const cleanMode = (mode || "set").toLowerCase();
        if (!["set", "add", "subtract"].includes(cleanMode)) {
            return json400(res, "mode invalide (set / add / subtract)");
        }

        const id  = String(userId).trim();
        const amt = toBigInt(amount);

        const user = await getUser(id);
        const oldBank = fmt(user.bank);

        let newBank;
        if (cleanMode === "set") {
            newBank = amt;
        } else if (cleanMode === "add") {
            newBank = toBigInt(user.bank) + amt;
        } else {
            newBank = toBigInt(user.bank) - amt;
            if (newBank < 0n) newBank = 0n;
        }

        user.bank = fmt(newBank);
        await saveUser(id, user);

        await addTx(id, "admin_set_balance", fmt(newBank - toBigInt(oldBank)), {
            reason: "admin_set_balance",
            mode:   cleanMode,
            amount: fmt(amt),
            oldBank,
            newBank: user.bank,
        });

        json200(res, {
            userId: id,
            mode: cleanMode,
            oldBalance: oldBank,
            newBalance: user.bank,
            appliedAmount: fmt(amt),
        });
    } catch (e) { json500(res, e.message); }
});

app.use((req, res) => {
    json404(res, `Route introuvable : ${req.method} ${req.path}`);
});

app.use((err, req, res, next) => {
    console.error("Erreur non gérée:", err);
    json500(res, err.message || "Erreur interne");
});

module.exports = app;
