const getCoinExpiryDate = (date) => {
  const expiryDate = new Date(date);

  expiryDate.setMonth(expiryDate.getMonth() + 6);

  return expiryDate;
};

const addMedishieldCoins = async (user, coins) => {
  coins = Number(coins);

  if (!Number.isFinite(coins) || coins <= 0) {
    return user;
  }

  if (!Array.isArray(user.medishieldcoins)) {
    user.medishieldcoins = [];
  }

  user.medishieldcoins.push({
    coins,
    date: new Date(),
  });

  await user.save();

  return user;
};

const getAvailableMedishieldCoins = (user) => {
  const now = new Date();

  if (!Array.isArray(user?.medishieldcoins)) {
    return 0;
  }

  return user.medishieldcoins.reduce((total, coinBatch) => {
    if (!coinBatch || !coinBatch.date) {
      return total;
    }

    const coins = Number(coinBatch.coins);

    if (!Number.isFinite(coins) || coins <= 0) {
      return total;
    }

    const expiryDate = getCoinExpiryDate(coinBatch.date);

    // Expired coins available balance me count nahi honge
    if (expiryDate <= now) {
      return total;
    }

    return total + coins;
  }, 0);
};

const deductMedishieldCoins = async (user, coinsToDeduct) => {
  console.log("========== COIN DEDUCTION ==========");
  console.log("coinsToDeduct BEFORE:", coinsToDeduct);
  console.log("user.medishieldcoins BEFORE:", user.medishieldcoins);
  coinsToDeduct = Number(coinsToDeduct);
  console.log(
    "coinsToDeduct AFTER:",
    coinsToDeduct
  );

  if (!Number.isFinite(coinsToDeduct) || coinsToDeduct <= 0) {
    return user;
  }

  if (!Array.isArray(user?.medishieldcoins)) {
    throw new Error("Insufficient Medishield coins");
  }

  const now = new Date();

  // Pehle invalid/null/expired/zero batches ko hata do
  user.medishieldcoins = user.medishieldcoins.filter((coinBatch) => {
    if (!coinBatch || !coinBatch.date) {
      return false;
    }

    const coins = Number(coinBatch.coins);

    if (!Number.isFinite(coins) || coins <= 0) {
      return false;
    }

    const expiryDate = getCoinExpiryDate(coinBatch.date);

    return expiryDate > now;
  });

  // Oldest earning date first
  user.medishieldcoins.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Check total available coins before making any changes
  const availableCoins = user.medishieldcoins.reduce(
    (total, coinBatch) => total + coinBatch.coins,
    0,
  );

  if (availableCoins < coinsToDeduct) {
    throw new Error("Insufficient Medishield coins");
  }

  let remainingToDeduct = coinsToDeduct;

  for (const coinBatch of user.medishieldcoins) {
    if (remainingToDeduct <= 0) {
      break;
    }

    if (coinBatch.coins <= remainingToDeduct) {
      remainingToDeduct -= coinBatch.coins;
      coinBatch.coins = 0;
    } else {
      coinBatch.coins -= remainingToDeduct;
      remainingToDeduct = 0;
    }
  }

  // Jinke coins completely use ho gaye un batches ko remove kar do
  user.medishieldcoins = user.medishieldcoins.filter(
    (coinBatch) => coinBatch.coins > 0,
  );

  console.log("========== AFTER DEDUCTION ==========");
  console.log("user.medishieldcoins AFTER:", user.medishieldcoins);
  await user.save();

  return user;
};

module.exports = {
  addMedishieldCoins,
  deductMedishieldCoins,
  getAvailableMedishieldCoins,
};