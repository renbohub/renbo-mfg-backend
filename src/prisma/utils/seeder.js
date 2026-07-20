const { prisma } = require("../index");
const bcrypt = require("bcrypt");

/**
 * Seeder untuk membuat default user pertama kali
 * Akan membuat super admin default jika belum ada user di database
 */
async function seedDefaultUser() {
  try {
    // Cek apakah sudah ada user di database
    const userCount = await prisma.user.count();

    if (userCount === 0) {
      console.log("🌱 Database kosong, membuat default super admin...");

      // Hash password
      const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || "admin123";
      const hashedPassword = await bcrypt.hash(defaultPassword, 10);

      // Data default super admin - bisa di-override dari environment
      const defaultUser = {
        username: process.env.DEFAULT_ADMIN_USERNAME || "admin",
        email: process.env.DEFAULT_ADMIN_EMAIL || "admin@example.com",
        password: hashedPassword,
        fullName: process.env.DEFAULT_ADMIN_FULLNAME || "Super Administrator",
        isSuperAdmin: true,
        listMenu: [],
      };

      await prisma.user.create({ data: defaultUser });

      console.log("✅ Default super admin berhasil dibuat:");
      console.log(
        `   Username: ${process.env.DEFAULT_ADMIN_USERNAME || "admin"}`,
      );
      console.log(
        `   Email: ${process.env.DEFAULT_ADMIN_EMAIL || "admin@example.com"}`,
      );
      console.log(`   Password: ${defaultPassword}`);
      console.log("   ⚠️  Harap ganti password setelah login pertama!");
    } else {
      console.log("📊 Database sudah memiliki user, seeder dilewati");
    }
  } catch (error) {
    console.error("❌ Error saat menjalankan seeder:", error.message);
    // Jangan throw error agar aplikasi tetap bisa jalan
  }
}

/**
 * Seeder untuk Payment Terms
 * Membuat data master Payment Terms standar jika belum ada
 */
async function seedPaymentTermData() {
  try {
    // Cek apakah sudah ada Payment Terms di database
    const paymentTermCount = await prisma.paymentTerm.count();

    if (paymentTermCount === 0) {
      console.log(
        "🌱 Database Payment Terms kosong, membuat data master Payment Terms...",
      );

      // Data Payment Terms standar
      const defaultPaymentTerms = [
        { termCode: "NET-30", description: "Net 30 Days", days: 30 },
        { termCode: "NET-60", description: "Net 60 Days", days: 60 },
        { termCode: "NET-90", description: "Net 90 Days", days: 90 },
        { termCode: "COD", description: "Cash on Delivery", days: 0 },
        { termCode: "PREPAID", description: "Prepaid", days: 0 },
        { termCode: "NET-15", description: "Net 15 Days", days: 15 },
        { termCode: "NET-45", description: "Net 45 Days", days: 45 },
        {
          termCode: "2-10-NET-30",
          description: "2% Discount if paid within 10 days, otherwise Net 30",
          days: 30,
        },
      ];

      // Insert semua Payment Terms sekaligus
      await prisma.paymentTerm.createMany({ data: defaultPaymentTerms });

      console.log(
        `✅ ${defaultPaymentTerms.length} Payment Terms berhasil dibuat`,
      );
      console.log(
        "   📝 Payment Terms yang dibuat:",
        defaultPaymentTerms.map((u) => u.termCode).join(", "),
      );
    } else {
      console.log(
        `📊 Database sudah memiliki ${paymentTermCount} Payment Terms, seeder dilewati`,
      );
    }
  } catch (error) {
    console.error(
      "❌ Error saat menjalankan Payment Terms seeder:",
      error.message,
    );
  }
}

/**
 * Seeder untuk UOM (Unit of Measure)
 * Membuat data master UOM standar jika belum ada
 */
async function seedUomData() {
  try {
    // Cek apakah sudah ada UOM di database
    const uomCount = await prisma.uom.count();

    if (uomCount === 0) {
      console.log("🌱 Database UOM kosong, membuat data master UOM...");

      // Data UOM standar
      const defaultUoms = [
        {
          uomCode: "kg",
          uomName: "Kilogram (kg)",
          notes: "Unit berat dalam kilogram",
        },
        { uomCode: "g", uomName: "Gram (g)", notes: "Unit berat dalam gram" },
        {
          uomCode: "lb",
          uomName: "Pound (lb)",
          notes: "Unit berat dalam pound",
        },
        {
          uomCode: "oz",
          uomName: "Ounce (oz)",
          notes: "Unit berat dalam ounce",
        },
        { uomCode: "ton", uomName: "Ton", notes: "Unit berat dalam ton" },
        {
          uomCode: "pcs",
          uomName: "Pieces (pcs)",
          notes: "Unit jumlah dalam pieces",
        },
        {
          uomCode: "m",
          uomName: "Meter (m)",
          notes: "Unit panjang dalam meter",
        },
        {
          uomCode: "cm",
          uomName: "Centimeter (cm)",
          notes: "Unit panjang dalam centimeter",
        },
        {
          uomCode: "mm",
          uomName: "Millimeter (mm)",
          notes: "Unit panjang dalam millimeter",
        },
        {
          uomCode: "in",
          uomName: "Inch (in)",
          notes: "Unit panjang dalam inch",
        },
        {
          uomCode: "ft",
          uomName: "Feet (ft)",
          notes: "Unit panjang dalam feet",
        },
        {
          uomCode: "l",
          uomName: "Liter (L)",
          notes: "Unit volume dalam liter",
        },
        {
          uomCode: "ml",
          uomName: "Milliliter (ml)",
          notes: "Unit volume dalam milliliter",
        },
      ];

      // Insert semua UOM sekaligus
      await prisma.uom.createMany({ data: defaultUoms });

      console.log(`✅ ${defaultUoms.length} UOM berhasil dibuat`);
      console.log(
        "   📝 UOM yang dibuat:",
        defaultUoms.map((u) => u.uomCode).join(", "),
      );
    } else {
      console.log(
        `📊 Database sudah memiliki ${uomCount} UOM, seeder dilewati`,
      );
    }
  } catch (error) {
    console.error("❌ Error saat menjalankan UOM seeder:", error.message);
  }
}

/**
 * Seeder untuk Currency
 * Membuat data master Currency standar jika belum ada
 */
async function seedCurrencyData() {
  try {
    // Cek apakah sudah ada Currency di database
    const currencyCount = await prisma.currency.count();

    if (currencyCount === 0) {
      console.log(
        "🌱 Database Currency kosong, membuat data master Currency...",
      );

      // Data Currency standar
      const defaultCurrencies = [
        {
          currencyCode: "IDR",
          currencyName: "Rupiah",
          symbol: "Rp",
          exchangeRate: 1.0,
        },
        {
          currencyCode: "USD",
          currencyName: "US Dollar",
          symbol: "$",
          exchangeRate: 15000.0,
        },
        {
          currencyCode: "EUR",
          currencyName: "Euro",
          symbol: "€",
          exchangeRate: 16500.0,
        },
        {
          currencyCode: "JPY",
          currencyName: "Japanese Yen",
          symbol: "¥",
          exchangeRate: 100.0,
        },
        {
          currencyCode: "GBP",
          currencyName: "British Pound",
          symbol: "£",
          exchangeRate: 19000.0,
        },
      ];

      // Insert semua Currency sekaligus
      await prisma.currency.createMany({ data: defaultCurrencies });

      console.log(`✅ ${defaultCurrencies.length} Currency berhasil dibuat`);
      console.log(
        "   📝 Currency yang dibuat:",
        defaultCurrencies.map((c) => c.currencyCode).join(", "),
      );
    } else {
      console.log(
        `📊 Database sudah memiliki ${currencyCount} Currency, seeder dilewati`,
      );
    }
  } catch (error) {
    console.error("❌ Error saat menjalankan Currency seeder:", error.message);
  }
}

/**
 * Seeder untuk Process
 * Membuat data master Process standar jika belum ada
 */
async function seedProcessData() {
  try {
    // Cek apakah sudah ada Process di database
    const processCount = await prisma.process.count();

    if (processCount === 0) {
      console.log("🌱 Database Process kosong, membuat data master Process...");

      // Data Process standar
      const defaultProcesses = [
        {
          processCode: "PRG",
          processName: "Progressive",
          notes:
            "Proses progresif stamping dengan multiple stages dalam satu die",
        },
        {
          processCode: "BE",
          processName: "BE",
          notes: "Proses Basic Engineering",
        },

        {
          processCode: "WELD-1",
          processName: "Weld - 1",
          notes: "Proses pengelasan tahap pertama",
        },
        {
          processCode: "SPOT_WELD",
          processName: "Spot Weld",
          notes: "Proses pengelasan titik untuk penyambungan material",
        },
        {
          processCode: "WELD-2",
          processName: "Weld - 2",
          notes: "Proses pengelasan tahap kedua",
        },
        {
          processCode: "WELD-3",
          processName: "Weld - 3",
          notes: "Proses pengelasan tahap ketiga",
        },
        {
          processCode: "WELD-4",
          processName: "Weld - 4",
          notes: "Proses pengelasan tahap keempat",
        },

        {
          processCode: "PAINT",
          processName: "Painting",
          notes: "Proses pengecatan untuk finishing dan proteksi",
        },

        {
          processCode: "SPOT",
          processName: "Spot",
          notes: "Proses spot welding atau spot treatment",
        },

        {
          processCode: "BLANK",
          processName: "Blanking",
          notes: "Proses pemotongan material untuk membentuk blank",
        },
        {
          processCode: "PIERC",
          processName: "Pierching",
          notes: "Proses pelubangan material dengan punch",
        },
        {
          processCode: "COIN",
          processName: "Coining",
          notes:
            "Proses pembentukan dengan tekanan tinggi untuk detail presisi",
        },
        {
          processCode: "BEND-1",
          processName: "Bending 1",
          notes: "Proses pembengkokan tahap pertama",
        },
        {
          processCode: "BEND-2",
          processName: "Bending 2",
          notes: "Proses pembengkokan tahap kedua",
        },
        {
          processCode: "CHAMP",
          processName: "Champer",
          notes: "Proses pembuatan chamfer pada sisi material",
        },

        {
          processCode: "EDP",
          processName: "EDP",
          notes: "Electro Deposition Process untuk coating protektif",
        },
        {
          processCode: "INSP-PACK",
          processName: "Inspect + Packing",
          notes: "Proses inspeksi kualitas dan pengemasan produk",
        },

        {
          processCode: "FG",
          processName: "Finish Goods",
          notes: "Proses finalisasi produk jadi siap kirim",
        },
      ];

      // Insert semua Process sekaligus
      await prisma.process.createMany({ data: defaultProcesses });

      console.log(`✅ ${defaultProcesses.length} Process berhasil dibuat`);
      console.log(
        "   📝 Process yang dibuat:",
        defaultProcesses.map((p) => p.processCode).join(", "),
      );
    } else {
      console.log(
        `📊 Database sudah memiliki ${processCount} Process, seeder dilewati`,
      );
    }
  } catch (error) {
    console.error("❌ Error saat menjalankan Process seeder:", error.message);
  }
}

/**
 * Seeder untuk Part
 * Membuat dummy data Part jika belum ada
 */
async function seedPartData() {
  try {
    const partCount = await prisma.part.count();

    if (partCount === 0) {
      console.log("🌱 Database Part kosong, membuat dummy data Part...");

      const defaultParts = [
        // Bracket Components
        {
          partCode: "001-11058-1292",
          partNumber: "11058-1292",
          partName: "BRACKET",
          type: "Component",
          category: "PD",
          spec: "SPHC PO",
          size: "175 x 83",
          cavity: 1,
          netWeight: 0.23,
          scrapWeight: 0.02,
          grossWeight: 0.25,
          customerCode: "001",
          notes: "Bracket component untuk assembly 23062-1498C",
        },
        {
          partCode: "001-11058-1287",
          partNumber: "11058-1287",
          partName: "BRACKET",
          type: "Component",
          category: "PD",
          spec: "SPHC PO",
          size: "145 x 1219",
          cavity: 1,
          netWeight: 2.7,
          scrapWeight: 0.3,
          grossWeight: 3.0,
          customerCode: "001",
          notes: "Bracket component dengan dimensi panjang",
        },
        {
          partCode: "001-11058-1288",
          partNumber: "11058-1288",
          partName: "BRACKET",
          type: "Component",
          category: "PD",
          spec: "SPHC PO",
          size: "145 x 55",
          cavity: 1,
          netWeight: 0.12,
          scrapWeight: 0.01,
          grossWeight: 0.13,
          customerCode: "001",
          notes: "Bracket component standar",
        },
        {
          partCode: "001-11058-1289",
          partNumber: "11058-1289",
          partName: "BRACKET",
          type: "Component",
          category: "PD",
          spec: "SPHC PO",
          size: "50 x C",
          cavity: 1,
          netWeight: 0.05,
          scrapWeight: 0.005,
          grossWeight: 0.055,
          customerCode: "001",
          notes: "Bracket kecil dengan ketebalan 1.6mm",
        },
        {
          partCode: "001-11058-1290",
          partNumber: "11058-1290",
          partName: "BRACKET",
          type: "Component",
          category: "PD",
          spec: "SPCC SD",
          size: "38 x C",
          cavity: 1,
          netWeight: 0.04,
          scrapWeight: 0.004,
          grossWeight: 0.044,
          customerCode: "001",
          notes: "Bracket dengan material SPCC SD",
        },
        {
          partCode: "001-11058-1291",
          partNumber: "11058-1291",
          partName: "BRACKET",
          type: "Component",
          category: "PD",
          spec: "SPHC PO",
          size: "65 x 1219",
          cavity: 1,
          netWeight: 1.0,
          scrapWeight: 0.1,
          grossWeight: 1.1,
          customerCode: "001",
          notes: "Bracket tipis dengan dimensi panjang",
        },

        // Pin & Bar Components
        {
          partCode: "001-92043-1766",
          partNumber: "92043-1766",
          partName: "PIN",
          type: "Component",
          category: "WD",
          spec: "SS400",
          size: "Ø8",
          cavity: 1,
          netWeight: 0.015,
          scrapWeight: 0.001,
          grossWeight: 0.016,
          customerCode: "001",
          notes: "Pin stainless steel diameter 8mm",
        },
        {
          partCode: "001-16149-0697A",
          partNumber: "16149-0697A",
          partName: "BAR",
          type: "Component",
          category: "WD",
          spec: "SS400",
          size: "Ø7",
          cavity: 1,
          netWeight: 0.012,
          scrapWeight: 0.001,
          grossWeight: 0.013,
          customerCode: "001",
          notes: "Bar component diameter 7mm",
        },
        {
          partCode: "001-16149-0698A",
          partNumber: "16149-0698A",
          partName: "BAR",
          type: "Component",
          category: "WD",
          spec: "SS400",
          size: "Ø7",
          cavity: 1,
          netWeight: 0.012,
          scrapWeight: 0.001,
          grossWeight: 0.013,
          customerCode: "001",
          notes: "Bar component diameter 7mm variant A",
        },

        // Clamp Components
        {
          partCode: "001-92173-2707A",
          partNumber: "92173-2707A",
          partName: "Clamp",
          type: "Component",
          category: "WD",
          spec: "SWM-B",
          size: "Ø4",
          cavity: 1,
          netWeight: 0.008,
          scrapWeight: 0.001,
          grossWeight: 0.009,
          customerCode: "001",
          notes: "Clamp type 2707A",
        },
        {
          partCode: "001-92173-2706B",
          partNumber: "92173-2706B",
          partName: "Clamp",
          type: "Component",
          category: "WD",
          spec: "SWM-B",
          size: "Ø4",
          cavity: 1,
          netWeight: 0.008,
          scrapWeight: 0.001,
          grossWeight: 0.009,
          customerCode: "001",
          notes: "Clamp type 2706B",
        },

        // Assembly & Fitting Components
        {
          partCode: "001-23062-1498C",
          partNumber: "23062-1498C",
          partName: "BRACKET-COMP",
          type: "FG",
          category: "PD",
          spec: "Assembly Component",
          size: "Assembly",
          cavity: 1,
          netWeight: 3.5,
          scrapWeight: 0.0,
          grossWeight: 3.5,
          customerCode: "001",
          notes: "Bracket complete assembly - main product",
        },
        {
          partCode: "001-B6H-F1347-00",
          partNumber: "B6H-F1347-00",
          partName: "Bracket Tank Fitting",
          type: "Component",
          category: "PD",
          spec: "SAPH440W",
          size: "97 x C",
          cavity: 1,
          netWeight: 0.15,
          scrapWeight: 0.015,
          grossWeight: 0.165,
          customerCode: "001",
          notes: "Tank fitting bracket dengan spot welding",
        },
        {
          partCode: "001-VGH6070",
          partNumber: "VGH6070",
          partName: "Side Board Angle L",
          type: "Component",
          category: "PD",
          spec: "SPHC-PO",
          size: "400 x 152",
          cavity: 1,
          netWeight: 0.95,
          scrapWeight: 0.1,
          grossWeight: 1.05,
          customerCode: "001",
          notes: "Side board angle shape L profile",
        },

        // Nuts & Fasteners
        {
          partCode: "001-370D0600",
          partNumber: "370D0600",
          partName: "NUT WELDING M6",
          type: "Component",
          category: "MD",
          spec: "M6 Welding Nut",
          size: "M6",
          cavity: 1,
          netWeight: 0.003,
          scrapWeight: 0.0,
          grossWeight: 0.003,
          customerCode: "001",
          notes: "Nut untuk welding M6 thread",
        },
      ];

      await prisma.part.createMany({ data: defaultParts });
      console.log(`✅ ${defaultParts.length} Part berhasil dibuat`);
    } else {
      console.log(
        `📊 Database sudah memiliki ${partCount} Part, seeder dilewati`,
      );
    }
  } catch (error) {
    console.error("❌ Error saat menjalankan Part seeder:", error.message);
  }
}

/**
 * Seeder untuk Material
 * Membuat dummy data Material jika belum ada
 */
async function seedMaterialData() {
  try {
    const materialCount = await prisma.material.count();

    if (materialCount === 0) {
      console.log(
        "🌱 Database Material kosong, membuat dummy data Material...",
      );

      const defaultMaterials = [
        // Besi / Iron Materials - sesuai dengan Part data PT Mistuba
        {
          materialCode: "01-SPHC-PO",
          materialType: "Besi",
          spec: "SPHC PO",
          thickness: 2.0,
          width: 1219,
          length: 2438,
          diameter: 10.5,
          uomCode: "kg",
          notes: "Hot rolled pickled & oiled steel - untuk bracket components",
        },
        {
          materialCode: "02-SPHC-PO",
          materialType: "Besi",
          spec: "SPHC PO",
          thickness: 1.6,
          width: 1219,
          length: 2438,
          diameter: 8.0,
          uomCode: "kg",
          notes: "Hot rolled pickled & oiled steel 1.6mm - bracket tipis",
        },
        {
          materialCode: "01-SPCC-SD",
          materialType: "Besi",
          spec: "SPCC SD",
          thickness: 1.6,
          width: 1000,
          length: 2000,
          diameter: 7.5,
          uomCode: "kg",
          notes: "Cold rolled steel - surface quality tinggi",
        },
        {
          materialCode: "01-SS400",
          materialType: "Besi",
          spec: "SS400",
          thickness: 1.6,
          width: 1000,
          length: 2000,
          diameter: 7.5,
          uomCode: "kg",
          notes: "Steel bar untuk pin, bar component, dan fastener",
        },

        // Stainless Steel
        {
          materialCode: "01-SS304",
          materialType: "Besi",
          spec: "SS304",
          thickness: 2.0,
          width: 1200,
          length: 2400,
          diameter: 2.0,
          uomCode: "kg",
          notes: "Stainless steel plate grade 304 - corrosion resistant",
        },

        // Non-Ferrous Materials
        {
          materialCode: "01-AL-6061",
          materialType: "Aluminum",
          spec: "6061 Alloy",
          thickness: 3.0,
          width: 1000,
          length: 2000,
          diameter: 16.2,
          uomCode: "kg",
          notes: "Aluminum alloy 6061",
        },
        {
          materialCode: "01-ABS-HI",
          materialType: "Plastic",
          spec: "ABS High impact",
          thickness: 5.0,
          width: 500,
          length: 500,
          diameter: null,
          uomCode: "kg",
          notes: "ABS plastic pellet",
        },
        {
          materialCode: "01-CU-WIRE",
          materialType: "Copper",
          spec: "2.5mm",
          thickness: null,
          width: null,
          length: null,
          diameter: 2.5,
          uomCode: "m",
          notes: "Copper wire for electrical",
        },
        {
          materialCode: "01-NBR-RUBBER",
          materialType: "Rubber",
          spec: "NBR gasket material",
          thickness: 3.0,
          width: 500,
          length: 500,
          diameter: null,
          uomCode: "pcs",
          notes: "NBR rubber gasket",
        },
        {
          materialCode: "01-CS-1045",
          materialType: "Besi",
          spec: "AISI 1045 bar",
          thickness: null,
          width: null,
          length: null,
          diameter: 25.0,
          uomCode: "kg",
          notes: "Carbon steel bar medium carbon",
        },
        {
          materialCode: "01-BRASS-10",
          materialType: "Brass",
          spec: "10mm diameter",
          thickness: null,
          width: null,
          length: null,
          diameter: 10.0,
          uomCode: "kg",
          notes: "Brass rod material",
        },
        {
          materialCode: "01-PA6-ENG",
          materialType: "Plastic",
          spec: "PA6 Engineering grade",
          thickness: null,
          width: null,
          length: null,
          diameter: null,
          uomCode: "kg",
          notes: "Nylon PA6 pellet",
        },
      ];

      await prisma.material.createMany({ data: defaultMaterials });
      console.log(`✅ ${defaultMaterials.length} Material berhasil dibuat`);
    } else {
      console.log(
        `📊 Database sudah memiliki ${materialCount} Material, seeder dilewati`,
      );
    }
  } catch (error) {
    console.error("❌ Error saat menjalankan Material seeder:", error.message);
  }
}

/**
 * Seeder untuk Customer
 * Membuat dummy data Customer jika belum ada - Generate 100 customers
 */
async function seedCustomerData() {
  try {
    const customerCount = await prisma.customer.count();

    if (customerCount === 0) {
      console.log(
        "🌱 Database Customer kosong, membuat dummy data Customer...",
      );

      // Template data untuk variasi
      const companyTypes = ["PT", "CV", "UD", "PT", "CV"];
      const companyNames = [
        "Mistuba Pipe Part Ind",
        "Steel Manufacturing",
        "Auto Components",
        "Precision Parts",
        "Metal Works",
        "Industrial Solutions",
        "Engineering Services",
        "Manufacturing Tech",
        "Automotive Parts",
        "Component Industries",
        "Metal Stamping",
        "Die Casting",
        "Precision Engineering",
        "Machinery Parts",
        "Industrial Components",
        "Steel Processing",
        "Metal Fabrication",
        "Automotive Solutions",
        "Parts Manufacturing",
        "Industrial Tech",
      ];
      const classificationOptions = [
        ["Regular"],
        ["Dies Only"],
        ["Job Order"],
        ["Regular", "Dies Only"],
        ["Regular", "Job Order"],
        ["Dies Only", "Job Order"],
      ];
      const paymentTermsList = [
        "NET-30",
        "NET-45",
        "NET-60",
        "NET-90",
        "COD",
        "PREPAID",
      ];
      const cities = [
        "Jakarta",
        "Bekasi",
        "Cikarang",
        "Karawang",
        "Surabaya",
        "Bandung",
        "Semarang",
        "Tangerang",
        "Bogor",
        "Cibitung",
      ];
      const contacts = [
        "Purchasing Manager",
        "Production Manager",
        "Procurement Head",
        "Supply Chain Manager",
        "Operations Manager",
        "General Manager",
      ];

      const defaultCustomers = [];

      // Generate 100 customers dengan loop
      for (let i = 1; i <= 1000; i++) {
        const code = String(i).padStart(3, "0");
        const companyType = companyTypes[i % companyTypes.length];
        const companyName = companyNames[i % companyNames.length];
        const city = cities[i % cities.length];
        const classification =
          classificationOptions[i % classificationOptions.length];
        const paymentTerms = paymentTermsList[i % paymentTermsList.length];
        const contact = contacts[i % contacts.length];

        // Variasi nama perusahaan dengan nomor untuk uniqueness
        const suffix = i > 20 ? ` ${Math.floor(i / 20)}` : "";
        const fullCompanyName = `${companyType} ${companyName}${suffix}`;

        defaultCustomers.push({
          customerCode: code,
          customerName: fullCompanyName,
          contact: contact,
          billingAddress: `Kawasan Industri ${city}, Blok A${i}, ${city}`,
          shippingAddress: `Kawasan Industri ${city}, Blok A${i}, ${city}`,
          currencyCode: i % 10 === 0 ? "USD" : "IDR", // Setiap 10 customer ada yang USD
          paymentTerms: paymentTerms,
          taxId: `01.${String(i).padStart(3, "0")}.${String(i * 7).padStart(3, "0")}.${String(i * 13).padStart(1, "0")}-${String(i).padStart(3, "0")}.000`,
          customerClassification: classification,
          notes: `${classification.join(", ")} customer - ${fullCompanyName}`,
        });
      }

      await prisma.customer.createMany({ data: defaultCustomers });
      console.log(`✅ ${defaultCustomers.length} Customer berhasil dibuat`);
    } else {
      console.log(
        `📊 Database sudah memiliki ${customerCount} Customer, seeder dilewati`,
      );
    }
  } catch (error) {
    console.error("❌ Error saat menjalankan Customer seeder:", error.message);
  }
}

/**
 * Seeder untuk Supplier
 * Membuat dummy data Supplier jika belum ada
 */
async function seedSupplierData() {
  try {
    const supplierCount = await prisma.supplier.count();

    if (supplierCount === 0) {
      console.log(
        "🌱 Database Supplier kosong, membuat dummy data Supplier...",
      );

      const defaultSuppliers = [
        {
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          contact: "Michael Tan",
          billingAddress: "Kawasan Industri MM2100, Bekasi 17520",
          shippingAddress: "Kawasan Industri MM2100, Bekasi 17520",
          leadTimeDays: 14,
          taxId: "02.234.567.8-901.000",
          users: ["operational", "engineer"],
          notes:
            "Supplier steel utama - Steel Plate & Coil Manufacturing - SPHC, SPCC, SAPH",
        },
        {
          supplierCode: "002",
          supplierName: "PT Krakatau Steel",
          contact: "Ahmad Wijaya",
          billingAddress: "Jl. Industri No.5, Cilegon 42435",
          shippingAddress: "Jl. Industri No.5, Cilegon 42435",
          leadTimeDays: 21,
          taxId: "02.345.678.9-012.000",
          users: ["operational"],
          notes: "Supplier steel plate domestik - Hot & Cold Rolled Steel",
        },
        {
          supplierCode: "003",
          supplierName: "PT Japfa Steel Processing",
          contact: "Budi Santoso",
          billingAddress: "Kawasan Industri Jababeka, Cikarang 17530",
          shippingAddress: "Kawasan Industri Jababeka, Cikarang 17530",
          leadTimeDays: 10,
          taxId: "02.456.789.0-123.000",
          users: ["operational", "engineer"],
          notes:
            "Supplier material processed steel - Steel Slitting & Processing",
        },
        {
          supplierCode: "004",
          supplierName: "CV Maju Jaya Hardware",
          contact: "Siti Aminah",
          billingAddress: "Jl. Raya Bekasi Km 25, Bekasi 17134",
          shippingAddress: "Jl. Raya Bekasi Km 25, Bekasi 17134",
          leadTimeDays: 7,
          taxId: "02.567.890.1-234.000",
          users: ["operational"],
          notes: "Supplier baut, mur, dan hardware - Fasteners & Hardware",
        },
      ];

      await prisma.supplier.createMany({ data: defaultSuppliers });
      console.log(`✅ ${defaultSuppliers.length} Supplier berhasil dibuat`);
    } else {
      console.log(
        `📊 Database sudah memiliki ${supplierCount} Supplier, seeder dilewati`,
      );
    }
  } catch (error) {
    console.error("❌ Error saat menjalankan Supplier seeder:", error.message);
  }
}

/**
 * Seeder untuk Vendor
 * Membuat dummy data Vendor jika belum ada
 */
async function seedVendorData() {
  try {
    const vendorCount = await prisma.vendor.count();

    if (vendorCount === 0) {
      console.log("🌱 Database Vendor kosong, membuat dummy data Vendor...");

      const defaultVendors = [
        {
          vendorCode: "001",
          vendorName: "PT Mandiri Coating Services",
          contact: "Hendra Kusuma",
          billingAddress: "Kawasan Industri Cibitung, Bekasi 17520",
          shippingAddress: "Kawasan Industri Cibitung, Bekasi 17520",
          leadTimeDays: 5,
          taxId: "03.234.567.8-901.000",
          users: ["operational"],
          notes:
            "Vendor painting & coating services - Powder Coating & Painting Services",
        },
        {
          vendorCode: "002",
          vendorName: "CV Jaya Welding",
          contact: "Darmawan",
          billingAddress: "Jl. Industri Raya No.15, Cikarang 17530",
          shippingAddress: "Jl. Industri Raya No.15, Cikarang 17530",
          leadTimeDays: 3,
          taxId: "03.345.678.9-012.000",
          users: ["operational", "engineer"],
          notes:
            "Vendor spot welding services - Welding & Fabrication Services",
        },
        {
          vendorCode: "003",
          vendorName: "PT Electro Plating Indonesia",
          contact: "Rudi Hartono",
          billingAddress: "Kawasan Industri MM2100, Bekasi 17520",
          shippingAddress: "Kawasan Industri MM2100, Bekasi 17520",
          leadTimeDays: 7,
          taxId: "03.456.789.0-123.000",
          users: ["operational"],
          notes:
            "Vendor electroplating & surface treatment - Electroplating & EDP Services",
        },
        {
          vendorCode: "004",
          vendorName: "CV Heat Treatment Specialist",
          contact: "Agus Salim",
          billingAddress: "Jl. Raya Narogong Km 12, Bekasi 17530",
          shippingAddress: "Jl. Raya Narogong Km 12, Bekasi 17530",
          leadTimeDays: 5,
          taxId: "03.567.890.1-234.000",
          users: ["engineer"],
          notes: "Vendor heat treatment & hardening - Heat Treatment Services",
        },
      ];

      await prisma.vendor.createMany({ data: defaultVendors });
      console.log(`✅ ${defaultVendors.length} Vendor berhasil dibuat`);
    } else {
      console.log(
        `📊 Database sudah memiliki ${vendorCount} Vendor, seeder dilewati`,
      );
    }
  } catch (error) {
    console.error("❌ Error saat menjalankan Vendor seeder:", error.message);
  }
}

/**
 * Seeder untuk PriceList
 * Membuat dummy data PriceList untuk Part dan Material
 */
async function seedPriceListData() {
  try {
    const priceListCount = await prisma.priceList.count();

    if (priceListCount === 0) {
      console.log(
        "🌱 Database PriceList kosong, membuat dummy data PriceList...",
      );

      // PriceList untuk Part - sesuai dengan data real PT Mistuba
      const partPriceLists = [
        {
          priceListCode: "PL-001-11058-1292-SUP001",
          itemType: "Part",
          partCode: "001-11058-1292",
          partNumber: "11058-1292",
          partName: "BRACKET",
          partSpec: "SPHC PO - 2.0 x 175 x 83",
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 12500,
          currencyCode: "IDR",
          uomCode: "pcs",
          pricingPeriod: "2026-01",
          notes: "Bracket main component",
        },
        {
          priceListCode: "PL-001-11058-1287-SUP001",
          itemType: "Part",
          partCode: "001-11058-1287",
          partNumber: "11058-1287",
          partName: "BRACKET",
          partSpec: "SPHC PO - 2.0 x 145 x 1219",
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 18000,
          currencyCode: "IDR",
          uomCode: "pcs",
          pricingPeriod: "2026-01",
          notes: "Bracket long dimension",
        },
        {
          priceListCode: "PL-001-11058-1288-SUP001",
          itemType: "Part",
          partCode: "001-11058-1288",
          partNumber: "11058-1288",
          partName: "BRACKET",
          partSpec: "SPHC PO - 2.0 x 145 x 55",
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 9500,
          currencyCode: "IDR",
          uomCode: "pcs",
          pricingPeriod: "2026-01",
          notes: "Bracket standard",
        },
        {
          priceListCode: "PL-001-11058-1289-SUP001",
          itemType: "Part",
          partCode: "001-11058-1289",
          partNumber: "11058-1289",
          partName: "BRACKET",
          partSpec: "SPHC PO - 1.6 x 50 x C",
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 6500,
          currencyCode: "IDR",
          uomCode: "pcs",
          pricingPeriod: "2026-01",
          notes: "Bracket small 1.6mm",
        },
        {
          priceListCode: "PL-001-11058-1290-SUP001",
          itemType: "Part",
          partCode: "001-11058-1290",
          partNumber: "11058-1290",
          partName: "BRACKET",
          partSpec: "SPCC SD - 1.6 x 38 x C",
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 5800,
          currencyCode: "IDR",
          uomCode: "pcs",
          pricingPeriod: "2026-01",
          notes: "Bracket SPCC material",
        },
        {
          priceListCode: "PL-001-92043-1766-SUP004",
          itemType: "Part",
          partCode: "001-92043-1766",
          partNumber: "92043-1766",
          partName: "PIN",
          partSpec: "SS400 - Ø8",
          supplierCode: "004",
          supplierName: "UD Logam Sejahtera",
          unitPrice: 3500,
          currencyCode: "IDR",
          uomCode: "pcs",
          pricingPeriod: "2026-01",
          notes: "Pin SS400 diameter 8mm",
        },
        {
          priceListCode: "PL-001-16149-0697A-SUP004",
          itemType: "Part",
          partCode: "001-16149-0697A",
          partNumber: "16149-0697A",
          partName: "BAR",
          partSpec: "SS400 - Ø7",
          supplierCode: "004",
          supplierName: "UD Logam Sejahtera",
          unitPrice: 2800,
          currencyCode: "IDR",
          uomCode: "pcs",
          pricingPeriod: "2026-01",
          notes: "Bar component",
        },
        {
          priceListCode: "PL-001-92173-2707A-SUP005",
          itemType: "Part",
          partCode: "001-92173-2707A",
          partNumber: "92173-2707A",
          partName: "Clamp",
          partSpec: "SWM-B - Ø4",
          supplierCode: "001",
          supplierName: "PT Material Prima",
          unitPrice: 1500,
          currencyCode: "IDR",
          uomCode: "pcs",
          pricingPeriod: "2026-01",
          notes: "Clamp type A",
        },
        {
          priceListCode: "PL-001-B6H-F1347-00-SUP001",
          itemType: "Part",
          partCode: "001-B6H-F1347-00",
          partNumber: "B6H-F1347-00",
          partName: "Bracket Tank Fitting",
          partSpec: "SAPH440W - 2.0 x 97 x C",
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 15500,
          currencyCode: "IDR",
          uomCode: "pcs",
          pricingPeriod: "2026-01",
          notes: "Tank fitting bracket",
        },
        {
          priceListCode: "PL-001-VGH6070-SUP001",
          itemType: "Part",
          partCode: "001-VGH6070",
          partNumber: "VGH6070",
          partName: "Side Board Angle L",
          partSpec: "SPHC-PO - 2.0 x 400 x 152",
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 28000,
          currencyCode: "IDR",
          uomCode: "pcs",
          pricingPeriod: "2026-01",
          notes: "Side board L profile",
        },
      ];

      // PriceList untuk Material - sesuai dengan material code baru
      const materialPriceLists = [
        // Besi / Steel Materials
        {
          priceListCode: "PL-SPHC-PO-SUP001",
          itemType: "Material",
          materialCode: "SPHC-PO",
          materialType: "Besi",
          materialSpec: "SPHC PO - Hot Rolled Steel Pickled & Oiled",
          materialThickness: 2.0,
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 18500,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Hot rolled pickled & oiled steel - harga per kg",
        },
        {
          priceListCode: "PL-SPHC-PO-1.6-SUP001",
          itemType: "Material",
          materialCode: "SPHC-PO-1.6",
          materialType: "Besi",
          materialSpec: "SPHC PO - 1.6mm thickness",
          materialThickness: 1.6,
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 17800,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Hot rolled steel 1.6mm - harga per kg",
        },
        {
          priceListCode: "PL-SPCC-SD-SUP001",
          itemType: "Material",
          materialCode: "SPCC-SD",
          materialType: "Besi",
          materialSpec: "SPCC SD - Cold Rolled Steel",
          materialThickness: 1.6,
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 21500,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Cold rolled steel - harga per kg",
        },
        {
          priceListCode: "PL-SS400-SUP001",
          itemType: "Material",
          materialCode: "SS400",
          materialType: "Besi",
          materialSpec: "SS400 - General Structural Steel",
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 16500,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Steel bar - harga per kg",
        },
        {
          priceListCode: "PL-SAPH440W-SUP001",
          itemType: "Material",
          materialCode: "SAPH440W",
          materialType: "Besi",
          materialSpec: "SAPH440W - Hot Rolled Steel for Automobile",
          materialThickness: 2.0,
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 22000,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Automotive grade steel - harga per kg",
        },
        {
          priceListCode: "PL-SWM-B-SUP004",
          itemType: "Material",
          materialCode: "SWM-B",
          materialType: "Besi",
          materialSpec: "SWM-B - Steel Wire Material",
          supplierCode: "004",
          supplierName: "UD Logam Sejahtera",
          unitPrice: 28000,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Steel wire - harga per kg",
        },
        {
          priceListCode: "PL-SS304-SUP001",
          itemType: "Material",
          materialCode: "SS304",
          materialType: "Besi",
          materialSpec: "SS304 - Stainless Steel 2mm thickness",
          materialThickness: 2.0,
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 85000,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Stainless steel plate - harga per kg",
        },
        {
          priceListCode: "PL-CS-1045-SUP001",
          itemType: "Material",
          materialCode: "CS-1045",
          materialType: "Besi",
          materialSpec: "AISI 1045 bar",
          supplierCode: "001",
          supplierName: "PT Steel Indonesia",
          unitPrice: 19500,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Carbon steel bar - harga per kg",
        },

        // Non-Ferrous Materials
        {
          priceListCode: "PL-AL-6061-SUP002",
          itemType: "Material",
          materialCode: "AL-6061",
          materialType: "Aluminum",
          materialSpec: "6061 - 3mm thickness",
          materialThickness: 3.0,
          supplierCode: "002",
          supplierName: "CV Aluminum Jaya",
          unitPrice: 45000,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Aluminum alloy - harga per kg",
        },
        {
          priceListCode: "PL-ABS-HI-SUP003",
          itemType: "Material",
          materialCode: "ABS-HI",
          materialType: "Plastic",
          materialSpec: "ABS High impact",
          supplierCode: "003",
          supplierName: "PT Plastik Nusantara",
          unitPrice: 38000,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "ABS plastic pellet - harga per kg",
        },
        {
          priceListCode: "PL-CU-WIRE-SUP005",
          itemType: "Material",
          materialCode: "CU-WIRE",
          materialType: "Copper",
          materialSpec: "2.5mm diameter",
          supplierCode: "001",
          supplierName: "PT Material Prima",
          unitPrice: 180000,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Copper wire - harga per kg",
        },
        {
          priceListCode: "PL-NBR-RUBBER-SUP003",
          itemType: "Material",
          materialCode: "NBR-RUBBER",
          materialType: "Rubber",
          materialSpec: "NBR gasket material",
          materialThickness: 3.0,
          supplierCode: "003",
          supplierName: "PT Plastik Nusantara",
          unitPrice: 95000,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "NBR rubber gasket - harga per kg",
        },
        {
          priceListCode: "PL-BRASS-10-SUP004",
          itemType: "Material",
          materialCode: "BRASS-10",
          materialType: "Brass",
          materialSpec: "10mm diameter",
          supplierCode: "004",
          supplierName: "UD Logam Sejahtera",
          unitPrice: 125000,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Brass rod - harga per kg",
        },
        {
          priceListCode: "PL-PA6-ENG-SUP003",
          itemType: "Material",
          materialCode: "PA6-ENG",
          materialType: "Plastic",
          materialSpec: "PA6 Engineering grade",
          supplierCode: "003",
          supplierName: "PT Plastik Nusantara",
          unitPrice: 48000,
          currencyCode: "IDR",
          uomCode: "kg",
          pricingPeriod: "2026-01",
          notes: "Nylon PA6 pellet - harga per kg",
        },
      ];

      // Gabungkan semua price lists
      const allPriceLists = [...partPriceLists, ...materialPriceLists];

      await prisma.priceList.createMany({ data: allPriceLists });
      console.log(
        `✅ ${allPriceLists.length} PriceList berhasil dibuat (${partPriceLists.length} Part, ${materialPriceLists.length} Material)`,
      );
    } else {
      console.log(
        `📊 Database sudah memiliki ${priceListCount} PriceList, seeder dilewati`,
      );
    }
  } catch (error) {
    console.error("❌ Error saat menjalankan PriceList seeder:", error.message);
  }
}

// // ============================================
// // INVENTORY - RACK (RAK PENYIMPANAN)
// // ============================================

// model Rack {
//   id            String   @id @default(uuid())
//   rackCode      String   @unique @map("rack_code")
//   rackName      String?  @map("rack_name")
//   zone          String? // Zona/area dalam warehouse (A, B, C, dll)
//   row           String? // Baris rak
//   level         String? // Level/tingkat rak
//   position      String? // Posisi spesifik
//   capacity      Float? // Kapasitas (m3, pallet, kg, dll)
//   capacityUnit  String?  @map("capacity_unit") // Satuan kapasitas
//   isActive      Boolean  @default(true) @map("is_active")
//   notes         String?
//   isDeleted     Boolean  @default(false) @map("is_deleted")
//   createdAt     DateTime @default(now()) @map("created_at")
//   updatedAt     DateTime @updatedAt @map("updated_at")

//   // Relations
//   stockBalances          StockBalance[]
//   sourceMovements        StockMovement[]  @relation("sourceRack")
//   destinationMovements   StockMovement[]  @relation("destinationRack")
//   goodsReceiptDetails    GoodsReceiptDetail[]
//   stockReservations      StockReservation[]

//   @@index([rackCode])
//   @@index([rackName])
//   @@index([zone])
//   @@index([isActive])
//   @@index([isDeleted])
//   @@map("tbl_rack")
// }

/**
 * Seeder untuk Rack
 * Membuat data real Rack Reject, Scrap, dan Rework sesuai dengan kondisi nyata di PT Mitsutoyo
 */
async function seedRackData() {
  try {
    // saya ingin check dulu apakah rackCode "RACK-REJECT, RACK-SCRAP, RACK-REWORK" sudah ada, kalau belum buat 3 rack default: RACK-REJECT, RACK-SCRAP, RACK-REWORK
    const rackCheck = await prisma.rack.findMany({
      where: {
        rackCode: {
          in: ["RACK-REJECT", "RACK-SCRAP", "RACK-REWORK"],
        },
      },
    });

    if (rackCheck.length === 0) {
      console.log("🌱 Database Rack kosong, membuat dummy data Rack...");
      const defaultRacks = [
        {
          rackCode: "RACK-REJECT",
          rackName: "Rack Reject",
          zone: "Reject Area",
          row: "R1",
          level: "L1",
        },
        {
          rackCode: "RACK-SCRAP",
          rackName: "Rack Scrap",
          zone: "Scrap Area",
          row: "R1",
          level: "L1",
        },
        {
          rackCode: "RACK-REWORK",
          rackName: "Rack Rework",
          zone: "Rework Area",
          row: "R1",
          level: "L1",
        },
      ];

      await prisma.rack.createMany({ data: defaultRacks });
      console.log(`✅ ${defaultRacks.length} Rack berhasil dibuat`);
    }
  } catch (error) {
    console.error("❌ Error saat menjalankan Rack seeder:", error.message);
  }
}

/**
 * Seeder tambahan untuk data master lainnya (jika diperlukan)
 */
async function seedMasterData() {
  try {
    // Jalankan seeder dalam urutan yang benar (karena ada foreign key dependencies)
    await seedPaymentTermData();
    await seedUomData();
    await seedCurrencyData();
    await seedProcessData();
    await seedRackData();

    if (process.env.NODE_ENV === "development") {
      // await seedPartData();
      // await seedMaterialData();
      // await seedCustomerData();
      // await seedSupplierData();
      // await seedVendorData();
      // await seedPriceListData(); // Harus terakhir karena depend on Part, Material, Supplier, Currency
    }

    console.log("✅ Master data seeding completed");
  } catch (error) {
    console.error(
      "❌ Error saat menjalankan master data seeder:",
      error.message,
    );
  }
}

/**
 * Fungsi utama untuk menjalankan semua seeder
 */
async function runSeeders() {
  console.log("🚀 Menjalankan database seeders...");

  await seedDefaultUser();
  await seedMasterData();

  console.log("🎉 Database seeding selesai!");
}

module.exports = runSeeders;
