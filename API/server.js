const express = require("express");
const cors = require("cors");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());
app.use(express.json());

const kv = Redis.fromEnv();

const USER_PREFIX          = "bank:user:";
const CARD_PREFIX          = "bank:card:";
const TX_PREFIX            = "bank:tx:";
const PARRAIN_USER_PREFIX  = "bank:parrain:user:";
const PARRAIN_CODE_PREFIX  = "bank:parrain:code:";
const PARRAIN_USED_PREFIX  = "bank:parrain:used:";

const MAX_LIMIT = 10n ** 261n;

function toBigInt(value) {
    if (typeof value === "bigint") return value;
    if (value === undefined || value === null) return 0n;
    try {
        const clean = String(value).split(".")[0].replace(/[^0-9\-]/g, "") || "0";
        const result = BigInt(clean);
        if (result >= MAX_LIMIT) return MAX_LIMIT;
        if (result <= -MAX_LIMIT) return -MAX_LIMIT;
        return result;
    } catch { return 0n; }
}

function fmt(v) {
    if (v === undefined || v === null) return "0";
    return toBigInt(v).toString();
}

function isValidAmount(str) {
    return typeof str === "string" && /^\d+$/.test(str) && str !== "0";
}

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function defaultUser(userId) {
    return {
        userId,
        bank: "0",
        lastInterestClaimed: Date.now(),
        imageMode: true,
        dailyStreak: 0,
        lastDaily: 0,
        totalInvested: "0",
        parrainCount: 0,
        savings: { amount: "0", releaseDate: 0 },
        loans: [],
    };
}

async function getUserData(userId) {
    try {
        const raw = await kv.get(`${USER_PREFIX}${userId}`);
        if (!raw) return defaultUser(userId);
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return { ...defaultUser(userId), ...parsed };
    } catch {
        return defaultUser(userId);
    }
}

async function setUserData(userId, data) {
    data.bank = fmt(data.bank);
    await kv.set(`${USER_PREFIX}${userId}`, JSON.stringify(data));
}

async function getUserCard(userId) {
    try {
        const raw = await kv.get(`${CARD_PREFIX}${userId}`);
        if (!raw) return null;
        return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch { return null; }
}

async function setUserCard(userId, cardData) {
    await kv.set(`${CARD_PREFIX}${userId}`, JSON.stringify(cardData));
}

async function addTransaction(userId, type, amount, details = {}) {
    try {
        const key = `${TX_PREFIX}${userId}`;
        const existing = await kv.get(key);
        let txs = existing ? (typeof existing === "string" ? JSON.parse(existing) : existing) : [];
        txs.unshift({ id: Date.now(), type, amount: fmt(amount), date: Date.now(), details });
        if (txs.length > 100) txs = txs.slice(0, 100);
        await kv.set(key, JSON.stringify(txs));
    } catch {}
}

function requireCard(card) {
    return !!(card && card.cardCreated);
}

function checkCvv(card, cvv) {
    const cvvNum = parseInt(cvv);
    return !isNaN(cvvNum) && card.cardCvv === cvvNum;
}

app.get("/", (req, res) => {
    res.json({ message: "Hedgehog Bank API", version: "7.0", status: "online", storage: "Upstash Redis" });
});

app.get("/api/bank/top", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 25, 100);
        const keys = await kv.keys(`${USER_PREFIX}*`);
        const users = [];
        for (const key of keys) {
            const userId = key.replace(USER_PREFIX, "");
            try {
                const raw = await kv.get(key);
                const data = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : { bank: "0" };
                users.push({ userId, bank: fmt(data.bank || "0") });
            } catch {
                users.push({ userId, bank: "0" });
            }
        }
        users.sort((a, b) => {
            const diff = toBigInt(b.bank) - toBigInt(a.bank);
            return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        });
        res.json({ success: true, data: users.slice(0, limit) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/api/bank/leaderboard", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 10, 50);
        const keys = await kv.keys(`${USER_PREFIX}*`);
        const users = [];
        for (const key of keys) {
            const userId = key.replace(USER_PREFIX, "");
            try {
                const raw = await kv.get(key);
                const data = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : { totalInvested: "0" };
                const totalInvested = fmt(data.totalInvested || "0");
                if (toBigInt(totalInvested) > 0n) users.push({ userId, totalInvested });
            } catch {}
        }
        users.sort((a, b) => {
            const diff = toBigInt(b.totalInvested) - toBigInt(a.totalInvested);
            return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        });
        res.json({ success: true, data: users.slice(0, limit) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/api/bank/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId) return res.status(400).json({ success: false, error: "userId manquant" });
        const user = await getUserData(userId);
        const card = await getUserCard(userId);
        res.json({
            success: true,
            data: { ...user, bank: fmt(user.bank), card: card || null, imageMode: user.imageMode !== false },
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/card", async (req, res) => {
    try {
        const { userId } = req.params;
        let card = await getUserCard(userId);
        if (requireCard(card)) return res.json({ success: true, data: card });

        const cardNumber = `4532 ${rand(1000, 9999)} ${rand(1000, 9999)} ${rand(1000, 9999)}`;
        const expiry = new Date();
        expiry.setFullYear(expiry.getFullYear() + 4);
        const expiryStr = `${expiry.getMonth() + 1}/${expiry.getFullYear().toString().slice(-2)}`;
        const cvv = rand(100, 999);
        card = { cardNumber, cardExpiry: expiryStr, cardCvv: cvv, cardCreated: 1 };
        await setUserCard(userId, card);

        const user = await getUserData(userId);
        await setUserData(userId, user);

        res.json({ success: true, data: card });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/deposit", async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount, cvv } = req.body;

        if (!isValidAmount(String(amount))) {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }

        const card = await getUserCard(userId);
        if (!requireCard(card)) return res.json({ success: false, error: "Aucune carte associée. Créez-en une avec bank card." });
        if (!checkCvv(card, cvv)) return res.json({ success: false, error: "CVV incorrect" });

        const amt = toBigInt(amount);
        const user = await getUserData(userId);
        user.bank = fmt(toBigInt(user.bank) + amt);
        await setUserData(userId, user);
        await addTransaction(userId, "deposit", amt);

        res.json({ success: true, data: { userId, bank: user.bank } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/withdraw", async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount, cvv } = req.body;

        if (!isValidAmount(String(amount))) {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }

        const card = await getUserCard(userId);
        if (!requireCard(card)) return res.json({ success: false, error: "Aucune carte associée. Créez-en une avec bank card." });
        if (!checkCvv(card, cvv)) return res.json({ success: false, error: "CVV incorrect" });

        const user = await getUserData(userId);
        const current = toBigInt(user.bank);
        const withdraw = toBigInt(amount);
        if (current < withdraw) return res.json({ success: false, error: "Solde insuffisant" });

        user.bank = fmt(current - withdraw);
        await setUserData(userId, user);
        await addTransaction(userId, "withdraw", fmt(-withdraw));

        res.json({ success: true, data: { userId, bank: user.bank } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/transfer", async (req, res) => {
    try {
        const { userId } = req.params;
        const { targetId, amount, cvv } = req.body;

        if (!isValidAmount(String(amount))) {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }
        if (!targetId || targetId === userId) {
            return res.status(400).json({ success: false, error: "Cible invalide" });
        }

        const card = await getUserCard(userId);
        if (!requireCard(card)) return res.json({ success: false, error: "Aucune carte associée. Créez-en une avec bank card." });
        if (!checkCvv(card, cvv)) return res.json({ success: false, error: "CVV incorrect" });

        const sender   = await getUserData(userId);
        const receiver = await getUserData(targetId);
        const senderBal = toBigInt(sender.bank);
        const amt = toBigInt(amount);

        if (senderBal < amt) return res.json({ success: false, error: "Solde insuffisant" });

        sender.bank   = fmt(senderBal - amt);
        receiver.bank = fmt(toBigInt(receiver.bank) + amt);
        await setUserData(userId, sender);
        await setUserData(targetId, receiver);

        await addTransaction(userId,   "transfer_sent",     fmt(-amt), { targetId, amount: fmt(amt) });
        await addTransaction(targetId, "transfer_received", fmt(amt),  { senderId: userId, amount: fmt(amt) });

        res.json({ success: true, newBalance: sender.bank, targetId, amount: fmt(amt) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/rob", async (req, res) => {
    try {
        const { userId } = req.params;
        const { targetId, amount } = req.body;

        if (!isValidAmount(String(amount))) {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }
        if (!targetId || targetId === userId) {
            return res.status(400).json({ success: false, error: "Cible invalide" });
        }

        const victim   = await getUserData(targetId);
        const victimBal = toBigInt(victim.bank);
        const robAmt    = toBigInt(amount);

        if (victimBal <= 0n) return res.json({ success: false, error: "La cible n'a rien en banque" });
        if (robAmt > victimBal) return res.json({ success: false, error: "Montant supérieur au solde actuel de la cible" });

        const robber = await getUserData(userId);
        robber.bank  = fmt(toBigInt(robber.bank) + robAmt);
        victim.bank  = fmt(victimBal - robAmt);

        await setUserData(userId, robber);
        await setUserData(targetId, victim);

        await addTransaction(userId,   "rob_sent",     fmt(robAmt),  { targetId });
        await addTransaction(targetId, "rob_received", fmt(-robAmt), { senderId: userId });

        res.json({ success: true, newBalance: robber.bank, robbed: fmt(robAmt) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/interest", async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await getUserData(userId);
        const current = toBigInt(user.bank);

        if (current <= 0n) return res.json({ success: false, error: "Aucun argent en banque" });

        const now  = Date.now();
        const last = user.lastInterestClaimed || now;
        const diffSeconds = Math.max(0, Math.floor((now - last) / 1000));

        if (diffSeconds < 60) {
            return res.json({ success: false, error: "Pas encore d'intérêts disponibles. Réessayez dans un instant." });
        }

        const interest = (current * 1000n * BigInt(diffSeconds)) / 970000000n;

        if (interest <= 0n) return res.json({ success: false, error: "Pas encore d'intérêts disponibles" });

        user.bank = fmt(current + interest);
        user.lastInterestClaimed = now;
        await setUserData(userId, user);
        await addTransaction(userId, "interest", fmt(interest));

        res.json({ success: true, data: { userId, bank: user.bank }, interestEarned: fmt(interest) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/gamble", async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount, choice } = req.body;

        if (!isValidAmount(String(amount))) {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }
        if (!["pile", "face"].includes(choice)) {
            return res.status(400).json({ success: false, error: "Choix invalide (pile ou face)" });
        }

        const user = await getUserData(userId);
        const bal  = toBigInt(user.bank);
        const bet  = toBigInt(amount);

        if (bal < bet) return res.json({ success: false, error: "Solde insuffisant" });

        const result = Math.random() < 0.5 ? "pile" : "face";
        const win    = result === choice;

        user.bank = fmt(win ? bal + bet : bal - bet);
        await setUserData(userId, user);
        await addTransaction(userId, win ? "gamble_win" : "gamble_lose", win ? fmt(bet) : fmt(-bet));

        res.json({ success: true, win, result, winAmount: win ? fmt(bet) : "0", newBalance: user.bank });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/lottery", async (req, res) => {
    try {
        const { ticketPrice } = req.body;

        if (!isValidAmount(String(ticketPrice))) {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }

        const ticket = toBigInt(ticketPrice);

        const userNumbers  = [rand(1, 9), rand(1, 9), rand(1, 9)];
        const drawnNumbers = [rand(1, 9), rand(1, 9), rand(1, 9)];
        let matchCount = 0;
        for (let i = 0; i < 3; i++) if (userNumbers[i] === drawnNumbers[i]) matchCount++;

        let multiplier = 0;
        if (matchCount === 3) multiplier = 100;
        else if (matchCount === 2) multiplier = 10;
        else if (matchCount === 1) multiplier = 2;

        const win = multiplier > 0;
        const winAmount = win ? ticket * BigInt(multiplier) : 0n;

        res.json({
            success: true,
            win,
            userNumbers,
            drawnNumbers,
            matchCount,
            multiplier,
            winAmount: fmt(winAmount),
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/api/bank/:userId/transactions", async (req, res) => {
    try {
        const { userId } = req.params;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const raw = await kv.get(`${TX_PREFIX}${userId}`);
        const txs = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];
        res.json({ success: true, data: txs.slice(0, limit) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/parrain/create", async (req, res) => {
    try {
        const { userId } = req.params;
        const existing = await kv.get(`${PARRAIN_USER_PREFIX}${userId}`);
        if (existing) {
            const d = typeof existing === "string" ? JSON.parse(existing) : existing;
            return res.json({ success: true, code: d.code });
        }
        const code = "HHG" + Math.random().toString(36).substring(2, 8).toUpperCase();
        await kv.set(`${PARRAIN_USER_PREFIX}${userId}`, JSON.stringify({ code, count: 0, gains: "0" }));
        await kv.set(`${PARRAIN_CODE_PREFIX}${code}`, userId);
        res.json({ success: true, code });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/parrain/use", async (req, res) => {
    try {
        const { userId } = req.params;
        const { code } = req.body;
        if (!code) return res.status(400).json({ success: false, error: "Code manquant" });

        const used = await kv.get(`${PARRAIN_USED_PREFIX}${userId}`);
        if (used) return res.json({ success: false, error: "Vous avez déjà utilisé un code de parrainage" });

        const ownerId = await kv.get(`${PARRAIN_CODE_PREFIX}${code}`);
        if (!ownerId) return res.json({ success: false, error: "Code invalide" });
        if (ownerId === userId) return res.json({ success: false, error: "Vous ne pouvez pas utiliser votre propre code" });

        const BONUS_USER  = 10000n;
        const BONUS_OWNER = 5000n;

        const userD  = await getUserData(userId);
        const ownerD = await getUserData(ownerId);

        userD.bank  = fmt(toBigInt(userD.bank) + BONUS_USER);
        ownerD.bank = fmt(toBigInt(ownerD.bank) + BONUS_OWNER);
        ownerD.parrainCount = (ownerD.parrainCount || 0) + 1;

        await setUserData(userId, userD);
        await setUserData(ownerId, ownerD);
        await kv.set(`${PARRAIN_USED_PREFIX}${userId}`, code);

        const op = await kv.get(`${PARRAIN_USER_PREFIX}${ownerId}`);
        if (op) {
            const d = typeof op === "string" ? JSON.parse(op) : op;
            d.count = (d.count || 0) + 1;
            d.gains = fmt(toBigInt(d.gains || "0") + BONUS_OWNER);
            await kv.set(`${PARRAIN_USER_PREFIX}${ownerId}`, JSON.stringify(d));
        }

        await addTransaction(userId,  "parrain_bonus",    fmt(BONUS_USER),  { code });
        await addTransaction(ownerId, "parrain_referral",  fmt(BONUS_OWNER), { referredUser: userId });

        res.json({ success: true, bonusUser: fmt(BONUS_USER), bonusOwner: fmt(BONUS_OWNER), newBalance: userD.bank });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/api/bank/:userId/parrain/stats", async (req, res) => {
    try {
        const { userId } = req.params;
        const raw = await kv.get(`${PARRAIN_USER_PREFIX}${userId}`);
        if (!raw) return res.json({ success: false, error: "Aucun code de parrainage créé" });
        const data = typeof raw === "string" ? JSON.parse(raw) : raw;
        res.json({ success: true, data: { code: data.code, count: data.count || 0, gains: data.gains || "0" } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/image", async (req, res) => {
    try {
        const { userId } = req.params;
        const { mode } = req.body;
        if (mode !== "on" && mode !== "off") {
            return res.status(400).json({ success: false, error: "Mode invalide (on/off)" });
        }
        const user = await getUserData(userId);
        user.imageMode = mode === "on";
        await setUserData(userId, user);
        res.json({ success: true, imageMode: user.imageMode });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/daily", async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await getUserData(userId);
        const now   = Date.now();
        const dayMs = 86400000;

        if (now - (user.lastDaily || 0) < dayMs) {
            return res.json({ success: false, error: "Bonus déjà réclamé aujourd'hui" });
        }

        let streak = user.dailyStreak || 0;
        if (now - (user.lastDaily || 0) > dayMs * 2) streak = 0;
        streak++;

        const reward = 1000n * BigInt(Math.min(streak, 30));
        user.bank = fmt(toBigInt(user.bank) + reward);
        user.lastDaily = now;
        user.dailyStreak = streak;
        await setUserData(userId, user);
        await addTransaction(userId, "daily_bonus", fmt(reward));

        res.json({ success: true, reward: fmt(reward), streak, newBalance: user.bank });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/invest", async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount } = req.body;

        if (!isValidAmount(String(amount))) {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }

        const user = await getUserData(userId);
        const investAmount = toBigInt(amount);
        const currentBank  = toBigInt(user.bank);

        if (investAmount > currentBank) {
            return res.json({ success: false, error: "Solde insuffisant" });
        }

        const chance = Math.random();
        let profit = 0n;
        if (chance < 0.6) profit = investAmount * 20n / 100n;
        else if (chance < 0.8) profit = 0n;
        else profit = -investAmount;

        user.bank = fmt(currentBank + profit);
        user.totalInvested = fmt(toBigInt(user.totalInvested || "0") + investAmount);
        await setUserData(userId, user);
        await addTransaction(userId, profit >= 0n ? "investment_win" : "investment_lose", fmt(profit));

        res.json({ success: true, profit: fmt(profit), newBalance: user.bank, totalInvested: user.totalInvested });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/loan", async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount } = req.body;

        if (!isValidAmount(String(amount))) {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }

        const user = await getUserData(userId);
        const loanAmount = toBigInt(amount);
        const maxLoan = toBigInt(user.bank) * 5n;

        if (maxLoan <= 0n) {
            return res.json({ success: false, error: "Vous devez avoir de l'argent en banque pour emprunter" });
        }
        if (loanAmount > maxLoan) {
            return res.json({ success: false, error: `Montant maximum d'emprunt : ${fmt(maxLoan)}` });
        }

        const interest    = loanAmount * 10n / 100n;
        const totalToPay  = loanAmount + interest;

        user.bank = fmt(toBigInt(user.bank) + loanAmount);
        if (!user.loans) user.loans = [];
        user.loans.push({ amount: fmt(loanAmount), interest: fmt(interest), total: fmt(totalToPay), date: Date.now(), status: "active" });
        await setUserData(userId, user);
        await addTransaction(userId, "loan_taken", fmt(loanAmount));

        res.json({ success: true, loanAmount: fmt(loanAmount), interest: fmt(interest), totalToPay: fmt(totalToPay), newBalance: user.bank });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/save", async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount } = req.body;

        if (!isValidAmount(String(amount))) {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }

        const user = await getUserData(userId);
        const saveAmount  = toBigInt(amount);
        const currentBank = toBigInt(user.bank);

        if (saveAmount > currentBank) {
            return res.json({ success: false, error: "Solde insuffisant" });
        }

        const currentSavings = toBigInt(user.savings?.amount || "0");
        user.bank = fmt(currentBank - saveAmount);
        user.savings = {
            amount: fmt(currentSavings + saveAmount),
            releaseDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
        };
        await setUserData(userId, user);
        await addTransaction(userId, "savings_deposit", fmt(-saveAmount));

        res.json({ success: true, savedAmount: fmt(saveAmount), newBalance: user.bank, releaseDate: user.savings.releaseDate });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/save/claim", async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await getUserData(userId);
        const savings = user.savings || { amount: "0", releaseDate: 0 };
        const amount = toBigInt(savings.amount || "0");

        if (amount <= 0n) return res.json({ success: false, error: "Aucune épargne disponible" });
        if (Date.now() < (savings.releaseDate || 0)) {
            return res.json({ success: false, error: "L'épargne n'est pas encore disponible", releaseDate: savings.releaseDate });
        }

        const bonus = amount * 5n / 100n;
        const total = amount + bonus;

        user.bank = fmt(toBigInt(user.bank) + total);
        user.savings = { amount: "0", releaseDate: 0 };
        await setUserData(userId, user);
        await addTransaction(userId, "savings_claim", fmt(total), { bonus: fmt(bonus) });

        res.json({ success: true, claimed: fmt(total), bonus: fmt(bonus), newBalance: user.bank });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/shop/buy", async (req, res) => {
    try {
        const { userId } = req.params;
        const { itemId } = req.body;

        const items = [
            { name: "VIP",           price: 50000000n, desc: "Accès à bank rob" },
            { name: "Double XP",     price: 1000000n,  desc: "Double gains pendant 24h" },
            { name: "Couleur Carte", price: 100000n,   desc: "Change la couleur de ta carte" },
        ];

        const id = parseInt(itemId);
        if (isNaN(id) || id < 1 || id > items.length) {
            return res.status(400).json({ success: false, error: "Article invalide" });
        }

        const item = items[id - 1];
        const user = await getUserData(userId);

        if (toBigInt(user.bank) < item.price) {
            return res.json({ success: false, error: "Solde insuffisant" });
        }

        user.bank = fmt(toBigInt(user.bank) - item.price);
        await setUserData(userId, user);
        await addTransaction(userId, "shop_purchase", fmt(-item.price), { item: item.name });

        res.json({ success: true, item: item.name, newBalance: user.bank });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/api/bank/shop/items", (req, res) => {
    const items = [
        { id: 1, name: "VIP",           price: "50000000", desc: "Accès à bank rob" },
        { id: 2, name: "Double XP",     price: "1000000",  desc: "Double gains pendant 24h" },
        { id: 3, name: "Couleur Carte", price: "100000",   desc: "Change la couleur de ta carte" },
    ];
    res.json({ success: true, data: items });
});

app.use((req, res) => {
    res.status(404).json({ success: false, error: "Route introuvable" });
});

app.use((err, req, res, next) => {
    console.error("Erreur non gérée:", err);
    res.status(500).json({ success: false, error: "Erreur interne du serveur" });
});

module.exports = app;