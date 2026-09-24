import { useEffect, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import LaoAddressSelect from "../components/LaoAddressSelect";
import ConfirmDestructiveModal from "../components/ConfirmDestructiveModal";
import {
  collection, getDocs, query, where, orderBy, limit,
  doc, getDoc, addDoc, updateDoc, deleteDoc, writeBatch,
  serverTimestamp, Timestamp,
} from "firebase/firestore";
import { sendPasswordResetEmail } from "firebase/auth";
import { db, auth } from "../firebase";
import type { Package } from "./PackageSettings";
import { UNIT_LABELS, fmtPrice } from "./PackageSettings";

interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

interface ShopTenant {
  id: string;
  shopName: string;
  ownerEmail: string;
  ownerUid: string;
  plan: "trial" | "monthly" | "yearly" | "unlimited";
  duration: number;
  status: "active" | "trial" | "suspended" | "cancelled";
  expiresAt?: Date;
  createdAt: Date;
  customerId: string;
  lastActive?: Date | null;
}

interface Payment {
  id: string;
  shopId: string;
  shopName: string;
  packageId: string | null;
  packageName: string | null;
  amount: number;
  method: "cash" | "transfer";
  slipUrl: string | null;
  periodFrom: string;
  periodTo: string;
  paidAt: Date;
  note: string;
}

const STATUS_CFG = {
  active:    { label: "ໃຊ້ງານ",    color: "var(--green)",  bg: "var(--green-bg)"  },
  trial:     { label: "ທົດລອງໃຊ້", color: "var(--yellow)", bg: "var(--yellow-bg)" },
  suspended: { label: "ລະງັບ",     color: "var(--red)",    bg: "var(--red-bg)"    },
  cancelled: { label: "ຍົກເລີກ",   color: "var(--muted)",  bg: "var(--surf2)"     },
};

function planLabel(plan: string, duration: number): string {
  if (plan === "unlimited") return "♾ ບໍ່ຈຳກັດ";
  if (plan === "monthly") return `ລາຍເດືອນ · ${duration} ເດືອນ`;
  if (plan === "yearly") return `ລາຍປີ · ${duration} ປີ`;
  return "ທົດລອງໃຊ້";
}

function unitToPlan(unit: Package["unit"]): ShopTenant["plan"] {
  if (unit === "unlimited") return "unlimited";
  if (unit === "year") return "yearly";
  if (unit === "month") return "monthly";
  return "trial";
}

function calcExpiry(duration: number, unit: Package["unit"]): Date | null {
  if (unit === "unlimited") return null;
  const d = new Date();
  if (unit === "month") d.setMonth(d.getMonth() + duration);
  else if (unit === "year") d.setFullYear(d.getFullYear() + duration);
  else d.setDate(d.getDate() + duration);
  return d;
}

function fmtAmount(n: number): string {
  return n.toLocaleString() + " ₭";
}

type MainTab = "shops" | "payments";

export default function CustomerShops() {
  const { customerId } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [shops, setShops] = useState<ShopTenant[]>([]);
  const [packages, setPackages] = useState<Package[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editShop, setEditShop] = useState<ShopTenant | null>(null);
  const [setPlanShop, setSetPlanShop] = useState<ShopTenant | null>(null);

  const [activeTab, setActiveTab] = useState<MainTab>("shops");
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [showAddPayment, setShowAddPayment] = useState(false);
  const [editPayment, setEditPayment] = useState<Payment | null>(null);
  const [deletePaymentId, setDeletePaymentId] = useState<string | null>(null);
  const [suspendShop, setSuspendShop] = useState<ShopTenant | null>(null);
  const [deleteShop, setDeleteShop] = useState<ShopTenant | null>(null);

  async function load() {
    if (!customerId) return;
    setLoading(true);
    try {
      const [custSnap, shopsSnap] = await Promise.all([
        getDoc(doc(db, "customers", customerId)),
        getDocs(query(collection(db, "tenants"), where("customerId", "==", customerId))),
      ]);
      if (custSnap.exists()) {
        const d = custSnap.data();
        setCustomer({ id: customerId, firstName: d.firstName ?? "", lastName: d.lastName ?? "", phone: d.phone ?? "", email: d.email ?? "" });
      }
      const shopList: ShopTenant[] = shopsSnap.docs.map(d => {
        const raw = d.data();
        return {
          id: d.id,
          shopName: raw.shopName ?? "",
          ownerEmail: raw.ownerEmail ?? "",
          ownerUid: raw.ownerUid ?? "",
          plan: raw.plan ?? "trial",
          duration: raw.duration ?? 1,
          status: raw.status ?? "trial",
          expiresAt: raw.expiresAt?.toDate?.() ?? undefined,
          createdAt: raw.createdAt?.toDate?.() ?? new Date(),
          customerId,
          lastActive: undefined,
        };
      });
      setShops(shopList);

      // Load last sale date for each shop in parallel
      const lastActivePairs = await Promise.all(
        shopList.map(async s => {
          try {
            const snap = await getDocs(query(
              collection(db, "shops", s.id, "sales"),
              orderBy("createdAt", "desc"),
              limit(1)
            ));
            return [s.id, snap.docs[0]?.data().createdAt?.toDate?.() ?? null] as const;
          } catch {
            return [s.id, null] as const;
          }
        })
      );
      const lastActiveMap = Object.fromEntries(lastActivePairs);
      setShops(prev => prev.map(s => ({ ...s, lastActive: lastActiveMap[s.id] ?? null })));
    } catch {} finally {
      setLoading(false);
    }

    // Load packages separately so a missing Firestore index won't block the customer from loading
    try {
      const pkgSnap = await getDocs(query(collection(db, "packages"), orderBy("order")));
      setPackages(
        pkgSnap.docs
          .filter(d => d.data().active !== false)
          .map(d => ({
            id: d.id,
            name: d.data().name ?? "",
            price: d.data().price ?? 0,
            currency: d.data().currency ?? "LAK",
            duration: d.data().duration ?? 1,
            unit: d.data().unit ?? "month",
            active: true,
            order: d.data().order ?? 0,
          }))
      );
    } catch {}
  }

  async function loadPayments() {
    if (!customerId) return;
    setPaymentsLoading(true);
    try {
      const snap = await getDocs(query(
        collection(db, "customers", customerId, "payments"),
        orderBy("paidAt", "desc")
      ));
      setPayments(snap.docs.map(d => ({
        id: d.id,
        shopId: d.data().shopId ?? "",
        shopName: d.data().shopName ?? "",
        packageId: d.data().packageId ?? null,
        packageName: d.data().packageName ?? null,
        amount: d.data().amount ?? 0,
        method: d.data().method ?? "cash",
        slipUrl: d.data().slipUrl ?? null,
        periodFrom: d.data().periodFrom ?? "",
        periodTo: d.data().periodTo ?? "",
        paidAt: d.data().paidAt?.toDate?.() ?? new Date(),
        note: d.data().note ?? "",
      })));
    } catch {} finally {
      setPaymentsLoading(false);
    }
  }

  useEffect(() => { load(); }, [customerId]);
  useEffect(() => { if (activeTab === "payments") loadPayments(); }, [activeTab, customerId]);

  const now = new Date();
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  const thisMonth = payments
    .filter(p => p.paidAt.getFullYear() === now.getFullYear() && p.paidAt.getMonth() === now.getMonth())
    .reduce((s, p) => s + p.amount, 0);

  async function doDeleteShop(s: ShopTenant) {
    const userSnap = await getDoc(doc(db, "users", s.ownerUid));
    const shopIds: string[] = userSnap.data()?.shopIds ?? [s.id];
    const remaining = shopIds.filter(id => id !== s.id);
    const batch = writeBatch(db);
    batch.delete(doc(db, "shops", s.id, "users", s.ownerUid));
    batch.delete(doc(db, "tenants", s.id));
    batch.delete(doc(db, "shops", s.id));
    if (remaining.length === 0) {
      batch.delete(doc(db, "users", s.ownerUid));
    } else {
      batch.update(doc(db, "users", s.ownerUid), { shopId: remaining[0], shopIds: remaining });
    }
    await batch.commit();
    setShops(prev => prev.filter(x => x.id !== s.id));
  }

  async function doToggleSuspend(s: ShopTenant) {
    setActionId(s.id);
    setSuspendShop(null);
    try {
      const newStatus = s.status === "suspended" ? "active" : "suspended";
      await updateDoc(doc(db, "tenants", s.id), { status: newStatus, updatedAt: serverTimestamp() });
      setShops(prev => prev.map(x => x.id === s.id ? { ...x, status: newStatus } : x));
    } finally {
      setActionId(null);
    }
  }

  if (!loading && !customer) {
    return <div style={{ padding: "32px 36px" }}><p style={{ color: "var(--muted)" }}>ບໍ່ພົບຂໍ້ມູນລູກຄ້າ</p></div>;
  }

  return (
    <div style={{ padding: "32px 36px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button
            onClick={() => navigate("/customers")}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "7px 14px", border: "1.5px solid var(--border)",
              borderRadius: 8, background: "var(--surf2)",
              fontSize: 13, fontWeight: 500, color: "var(--text-2)", cursor: "pointer",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            ກັບຄືນ
          </button>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)" }}>
                {customer ? `${customer.firstName} ${customer.lastName}` : "..."}
              </h1>
              {!loading && (
                <span style={{
                  fontSize: 13, fontWeight: 700, borderRadius: 20, padding: "2px 11px",
                  color: "#3b82f6", background: "rgba(59,130,246,.1)",
                  border: "1px solid rgba(59,130,246,.25)",
                }}>{shops.length} ຮ້ານ</span>
              )}
            </div>
            <p style={{ fontSize: 14, color: "var(--text-2)" }}>{customer?.phone}</p>
          </div>
        </div>

        {activeTab === "shops" ? (
          <button
            onClick={() => setShowCreate(true)}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "9px 18px", background: "var(--accent)",
              border: "none", borderRadius: 8, color: "#fff",
              fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "background .15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--accent-dark)")}
            onMouseLeave={e => (e.currentTarget.style.background = "var(--accent)")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            ສ້າງຮ້ານ
          </button>
        ) : (
          <button
            onClick={() => setShowAddPayment(true)}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "9px 18px", background: "#10b981",
              border: "none", borderRadius: 8, color: "#fff",
              fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "opacity .15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = "0.85")}
            onMouseLeave={e => (e.currentTarget.style.opacity = "1")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            ບັນທຶກການຊຳລະ
          </button>
        )}
      </div>

      {/* Tab switcher */}
      <div style={{ display: "flex", borderBottom: "2px solid var(--border)", marginBottom: 24 }}>
        {([
          { id: "shops" as const, label: "ຮ້ານ", count: shops.length },
          { id: "payments" as const, label: "ການຊຳລະ", count: payments.length },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "10px 20px", border: "none", background: "none",
              fontSize: 14, fontWeight: 600,
              color: activeTab === tab.id ? "var(--accent)" : "var(--text-2)",
              borderBottom: `2px solid ${activeTab === tab.id ? "var(--accent)" : "transparent"}`,
              marginBottom: -2, cursor: "pointer", transition: "color .15s",
            }}
          >
            {tab.label}
            {(tab.id === "shops" || payments.length > 0) && (
              <span style={{
                fontSize: 11, fontWeight: 700, borderRadius: 20, padding: "1px 7px",
                background: activeTab === tab.id ? "var(--accent-bg)" : "var(--surf2)",
                color: activeTab === tab.id ? "var(--accent)" : "var(--muted)",
              }}>{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Shops tab ── */}
      {activeTab === "shops" && (
        <div style={{ background: "var(--surf)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          {loading ? (
            <div style={{ padding: 60, display: "flex", justifyContent: "center" }}><div className="spinner"/></div>
          ) : shops.length === 0 ? (
            <div style={{ padding: "60px 24px", textAlign: "center" }}>
              <div style={{ fontSize: 14, color: "var(--muted)" }}>ຍັງບໍ່ມີຮ້ານ ກົດ "ສ້າງຮ້ານ" ເພື່ອເລີ່ມ</div>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--surf2)" }}>
                    {["ຊື່ຮ້ານ", "ອີເມວ", "ແພັກເກດ", "ສະຖານະ", "ວັນເລີ່ມໃຊ້", "ໝົດອາຍຸ", "ໃຊ້ລ່າສຸດ", ""].map(h => (
                      <th key={h} style={{
                        padding: "11px 20px", textAlign: "left",
                        fontSize: 12, fontWeight: 600, letterSpacing: ".05em",
                        textTransform: "uppercase", color: "var(--muted)", whiteSpace: "nowrap",
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shops.map(s => {
                    const cfg = STATUS_CFG[s.status] ?? STATUS_CFG.cancelled;
                    return (
                      <tr key={s.id}
                        style={{ borderBottom: "1px solid var(--border)", transition: "background .1s" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--surf2)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <td style={{ padding: "14px 20px", fontWeight: 600, color: "var(--text)" }}>{s.shopName}</td>
                        <td style={{ padding: "14px 20px", color: "var(--text-2)", fontSize: 13 }}>{s.ownerEmail}</td>
                        <td style={{ padding: "14px 20px", color: "var(--text-2)", fontSize: 13 }}>{planLabel(s.plan, s.duration)}</td>
                        <td style={{ padding: "14px 20px" }}>
                          <span style={{
                            display: "inline-block", fontSize: 12, fontWeight: 600,
                            color: cfg.color, background: cfg.bg,
                            border: `1px solid ${cfg.color}30`, borderRadius: 20, padding: "2px 10px",
                          }}>{cfg.label}</span>
                        </td>
                        <td style={{ padding: "14px 20px", color: "var(--muted)", fontSize: 13, whiteSpace: "nowrap" }}>
                          {s.createdAt.toLocaleDateString("en-GB")}
                        </td>
                        <td style={{ padding: "14px 20px", fontSize: 13, whiteSpace: "nowrap", color: s.plan === "unlimited" ? "var(--green)" : "var(--muted)", fontWeight: s.plan === "unlimited" ? 600 : 400 }}>
                          {s.plan === "unlimited" ? "♾ ບໍ່ຈຳກັດ" : s.expiresAt ? s.expiresAt.toLocaleDateString("en-GB") : "—"}
                        </td>
                        <td style={{ padding: "14px 20px", color: "var(--muted)", fontSize: 13, whiteSpace: "nowrap" }}>
                          {s.lastActive === undefined ? "..." : s.lastActive ? (
                            <>
                              {s.lastActive.toLocaleDateString("en-GB")}
                              <span style={{ display: "block", fontSize: 11, marginTop: 1 }}>
                                {s.lastActive.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                              </span>
                            </>
                          ) : "—"}
                        </td>
                        <td style={{ padding: "14px 20px" }}>
                          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                            <button
                              onClick={() => setEditShop(s)}
                              style={{
                                padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500,
                                border: "1px solid rgba(59,130,246,.3)",
                                background: "var(--blue-bg)", color: "var(--blue)", cursor: "pointer",
                              }}
                            >ແກ້ໄຂ</button>
                            <button
                              onClick={() => setSetPlanShop(s)}
                              style={{
                                padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500,
                                border: "1px solid rgba(139,92,246,.3)",
                                background: "var(--purple-bg, rgba(139,92,246,.08))", color: "var(--purple, #7c3aed)", cursor: "pointer",
                              }}
                            >ຕັ້ງຄ່າ</button>
                            <button
                              onClick={() => setSuspendShop(s)}
                              disabled={actionId === s.id}
                              style={{
                                padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500,
                                border: `1px solid ${s.status === "suspended" ? "rgba(16,185,129,.3)" : "rgba(239,68,68,.3)"}`,
                                background: s.status === "suspended" ? "var(--green-bg)" : "var(--red-bg)",
                                color: s.status === "suspended" ? "var(--green)" : "var(--red)",
                                cursor: actionId === s.id ? "not-allowed" : "pointer",
                                opacity: actionId === s.id ? 0.6 : 1,
                              }}
                            >{s.status === "suspended" ? "ເປີດໃຊ້ງານ" : "ລະງັບ"}</button>
                            <button
                              onClick={() => setDeleteShop(s)}
                              style={{
                                padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500,
                                border: "1px solid rgba(239,68,68,.3)",
                                background: "var(--red-bg)", color: "var(--red)", cursor: "pointer",
                              }}
                            >ລຶບ</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Payments tab ── */}
      {activeTab === "payments" && (
        <>
          {!paymentsLoading && payments.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
              {[
                { label: "ຈ່າຍທັງໝົດ", value: fmtAmount(totalPaid), color: "var(--text)" },
                { label: "ເດືອນນີ້",   value: fmtAmount(thisMonth), color: "#10b981" },
                { label: "ຈຳນວນຄັ້ງ", value: `${payments.length} ຄັ້ງ`, color: "var(--text)" },
              ].map(stat => (
                <div key={stat.label} style={{
                  background: "var(--surf)", border: "1px solid var(--border)",
                  borderRadius: 10, padding: "16px 20px",
                }}>
                  <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: ".04em" }}>
                    {stat.label}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: stat.color }}>{stat.value}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ background: "var(--surf)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
            {paymentsLoading ? (
              <div style={{ padding: 60, display: "flex", justifyContent: "center" }}><div className="spinner"/></div>
            ) : payments.length === 0 ? (
              <div style={{ padding: "60px 24px", textAlign: "center" }}>
                <div style={{ fontSize: 14, color: "var(--muted)" }}>ຍັງບໍ່ມີການຊຳລະ ກົດ "ບັນທຶກການຊຳລະ" ເພື່ອເພີ່ມ</div>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--surf2)" }}>
                      {["ວັນທີ", "ຮ້ານ", "ແພັກເກດ", "ຈຳນວນ", "ວິທີ", "ສະລີບ", "ໝາຍເຫດ", ""].map(h => (
                        <th key={h} style={{
                          padding: "11px 20px", textAlign: "left",
                          fontSize: 12, fontWeight: 600, letterSpacing: ".05em",
                          textTransform: "uppercase", color: "var(--muted)", whiteSpace: "nowrap",
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map(p => (
                      <tr key={p.id}
                        style={{ borderBottom: "1px solid var(--border)", transition: "background .1s" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--surf2)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <td style={{ padding: "14px 20px", color: "var(--text)", fontSize: 13, whiteSpace: "nowrap" }}>
                          {p.paidAt.toLocaleDateString("en-GB")}
                        </td>
                        <td style={{ padding: "14px 20px", fontWeight: 600, color: "var(--text)" }}>{p.shopName}</td>
                        <td style={{ padding: "14px 20px", fontSize: 13, color: "var(--text-2)" }}>
                          {p.packageName
                            ? <span style={{ fontWeight: 600, color: "var(--accent)" }}>{p.packageName}</span>
                            : <span style={{ color: "var(--muted)" }}>—</span>}
                        </td>
                        <td style={{ padding: "14px 20px", fontWeight: 700, color: "#10b981", whiteSpace: "nowrap" }}>{fmtAmount(p.amount)}</td>
                        <td style={{ padding: "14px 20px" }}>
                          <span style={{
                            display: "inline-block", fontSize: 12, fontWeight: 600, borderRadius: 20, padding: "2px 10px",
                            ...(p.method === "transfer"
                              ? { color: "var(--blue)", background: "var(--blue-bg)", border: "1px solid rgba(59,130,246,.3)" }
                              : { color: "#10b981", background: "var(--green-bg)", border: "1px solid rgba(16,185,129,.3)" }
                            ),
                          }}>
                            {p.method === "transfer" ? "ໂອນ" : "ສົດ"}
                          </span>
                        </td>
                        <td style={{ padding: "14px 20px" }}>
                          {p.slipUrl
                            ? <a href={p.slipUrl} target="_blank" rel="noreferrer" style={{ display: "inline-block" }}>
                                <img src={p.slipUrl} alt="slip" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />
                              </a>
                            : <span style={{ color: "var(--muted)", fontSize: 13 }}>—</span>}
                        </td>
                        <td style={{ padding: "14px 20px", color: "var(--muted)", fontSize: 13, maxWidth: 160 }}>{p.note || "—"}</td>
                        <td style={{ padding: "14px 16px", whiteSpace: "nowrap" }}>
                          <button onClick={() => setEditPayment(p)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-2)", padding: "4px 6px", borderRadius: 6 }} title="ແກ້ໄຂ">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                          </button>
                          <button onClick={() => setDeletePaymentId(p.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)", padding: "4px 6px", borderRadius: 6 }} title="ລົບ">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Modals */}
      {showCreate && customerId && (
        <CreateShopModal
          customerId={customerId}
          packages={packages}
          ownerEmail={customer?.email ?? ""}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
      {editShop && (
        <EditShopModal
          shop={editShop}
          onClose={() => setEditShop(null)}
          onSaved={(updated) => {
            setShops(prev => prev.map(s => s.id === updated.id ? updated : s));
            setEditShop(null);
          }}
        />
      )}
      {setPlanShop && (
        <SetPlanModal
          shop={setPlanShop}
          packages={packages}
          onClose={() => setSetPlanShop(null)}
          onUpdated={() => { setSetPlanShop(null); load(); }}
        />
      )}
      {showAddPayment && customerId && (
        <AddPaymentModal
          customerId={customerId}
          shops={shops}
          packages={packages}
          onClose={() => setShowAddPayment(false)}
          onCreated={() => { setShowAddPayment(false); loadPayments(); }}
        />
      )}
      {editPayment && customerId && (
        <EditPaymentModal
          customerId={customerId}
          payment={editPayment}
          shops={shops}
          packages={packages}
          onClose={() => setEditPayment(null)}
          onSaved={() => { setEditPayment(null); loadPayments(); }}
        />
      )}
      {deletePaymentId && customerId && (
        <ConfirmDeletePaymentModal
          customerId={customerId}
          paymentId={deletePaymentId}
          onClose={() => setDeletePaymentId(null)}
          onDeleted={() => { setDeletePaymentId(null); loadPayments(); }}
        />
      )}
      {suspendShop && (
        <ConfirmSuspendModal
          shop={suspendShop}
          onClose={() => setSuspendShop(null)}
          onConfirm={() => doToggleSuspend(suspendShop)}
        />
      )}

      {deleteShop && (
        <ConfirmDestructiveModal
          title={`ລຶບຮ້ານ: ${deleteShop.shopName}`}
          warning={
            <>
              ລຶບຮ້ານ <strong>{deleteShop.shopName}</strong> ຈະລົບ account ຮ້ານນີ້ຖາວອນ.{" "}
              {shops.length === 1
                ? "ນີ້ເປັນຮ້ານດຽວ — account login ຂອງ user ຈະຖືກລຶບດ້ວຍ."
                : `user ຍັງມີ ${shops.length - 1} ຮ້ານທີ່ເຫຼືອ — login email ຍັງໃຊ້ໄດ້ຢູ່.`}
            </>
          }
          confirmLabel="ລຶບຮ້ານ"
          onConfirm={() => doDeleteShop(deleteShop)}
          onClose={() => setDeleteShop(null)}
        />
      )}
    </div>
  );
}

// ─── Package Info Preview ──────────────────────────────────────────────

function PackagePreview({ pkg }: { pkg: Package }) {
  return (
    <div style={{
      marginTop: 8, padding: "10px 14px",
      background: "var(--accent-bg)", border: "1px solid rgba(14,165,160,.2)",
      borderRadius: 8, fontSize: 13,
    }}>
      <span style={{ color: "var(--accent)", fontWeight: 700 }}>
        {fmtPrice(pkg.price, pkg.currency)}
      </span>
      <span style={{ color: "var(--text-2)", marginLeft: 8 }}>
        · {pkg.duration} {UNIT_LABELS[pkg.unit]}
      </span>
    </div>
  );
}

// ─── Create Shop Modal ─────────────────────────────────────────────────

function CreateShopModal({ customerId, packages, ownerEmail, onClose, onCreated }: {
  customerId: string;
  packages: Package[];
  ownerEmail: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState(ownerEmail);
  const [shopName, setShopName] = useState("");
  const [village, setVillage] = useState("");
  const [district, setDistrict] = useState("");
  const [province, setProvince] = useState("");
  const [packageId, setPackageId] = useState(packages[0]?.id ?? "");
  const [returnEnabled, setReturnEnabled] = useState(false);
  const [returnSummaryEnabled, setReturnSummaryEnabled] = useState(false);
  const [monthlySummaryEnabled, setMonthlySummaryEnabled] = useState(false);
  const [ledgerEnabled, setLedgerEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedPkg = packages.find(p => p.id === packageId);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPkg) { setError("ກະລຸນາເລືອກແພັກເກດ"); return; }
    setError(""); setBusy(true);
    try {
      // shopId is independent from uid — supports multiple shops per owner
      const shopRef = doc(collection(db, "shops"));
      const shopId = shopRef.id;

      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      const rand = new Uint8Array(16);
      crypto.getRandomValues(rand);
      const tempPassword = Array.from(rand, b => chars[b % 62]).join("") + "Aa1!";

      const signUpRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${import.meta.env.VITE_FIREBASE_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim(), password: tempPassword, returnSecureToken: false }),
        }
      );
      const signUpData = await signUpRes.json();

      let uid: string;
      let isNewUser = true;

      if (!signUpRes.ok) {
        const code: string = signUpData.error?.message ?? "CREATE_USER_FAILED";
        if (code !== "EMAIL_EXISTS") throw new Error(code);
        // Email already has an account — find their UID and add the new shop to their list
        const existingSnap = await getDocs(query(collection(db, "users"), where("email", "==", email.trim())));
        if (existingSnap.empty) throw new Error("ອີເມວນີ້ມີໃນ Auth ແຕ່ຫາ User document ບໍ່ພົບ");
        uid = existingSnap.docs[0].id;
        isNewUser = false;
      } else {
        uid = signUpData.localId;
      }

      const plan = unitToPlan(selectedPkg.unit);
      const expiryDate = calcExpiry(selectedPkg.duration, selectedPkg.unit);
      const expiresAt = expiryDate ? Timestamp.fromDate(expiryDate) : null;
      const now = serverTimestamp();
      const features = { returnEnabled, returnSummaryEnabled, monthlySummaryEnabled, ledgerEnabled };

      const batch = writeBatch(db);

      if (isNewUser) {
        batch.set(doc(db, "users", uid), {
          role: "customer", shopId, shopIds: [shopId],
          email: email.trim(), createdAt: now,
        });
      } else {
        // Query tenants to get shops this uid actually owns (source of truth)
        const ownedSnap = await getDocs(query(collection(db, "tenants"), where("ownerUid", "==", uid)));
        const actualShopIds = ownedSnap.docs.map(d => d.id);
        batch.update(doc(db, "users", uid), {
          shopId: actualShopIds[0] ?? shopId,
          shopIds: [...actualShopIds, shopId],
        });
      }

      batch.set(shopRef, {
        name: shopName.trim(), customerId,
        village: village.trim(), district: district.trim(), province: province.trim(),
        features, createdAt: now,
      });
      batch.set(doc(db, `shops/${shopId}/users`, uid), { role: "customer", email: email.trim(), createdAt: now });
      batch.set(doc(db, "tenants", shopId), {
        shopName: shopName.trim(), ownerEmail: email.trim(), ownerUid: uid,
        customerId, packageId: selectedPkg.id,
        plan, duration: selectedPkg.duration,
        status: plan === "trial" ? "trial" : "active",
        expiresAt, createdAt: now,
      });

      await batch.commit();
      if (isNewUser) await sendPasswordResetEmail(auth, email.trim());
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "ເກີດຂໍ້ຜິດພາດ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={overlayRef} onClick={handleOverlayClick} style={{
      position: "fixed", inset: 0, background: "rgba(10,22,40,.6)",
      backdropFilter: "blur(3px)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 200, padding: 20,
    }}>
      <div style={{
        background: "var(--surf)", borderRadius: 14, width: "100%", maxWidth: 460,
        boxShadow: "0 20px 60px rgba(0,0,0,.2)", overflow: "hidden",
        maxHeight: "90vh", display: "flex", flexDirection: "column",
      }}>
        <div style={{
          padding: "20px 24px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>ສ້າງຮ້ານໃໝ່</div>
            <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 2 }}>ລະຫັດຜ່ານຈະຖືກສົ່ງໄປ Email ຂອງລູກຄ້າທັນທີ</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", padding: 4, borderRadius: 6, cursor: "pointer" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: "24px", overflowY: "auto" }}>
          {packages.length === 0 ? (
            <div style={{ padding: "12px 16px", marginBottom: 16, background: "var(--yellow-bg, rgba(234,179,8,.1))", border: "1px solid rgba(234,179,8,.3)", borderRadius: 8, fontSize: 13, color: "var(--yellow, #ca8a04)" }}>
              ⚠️ ຍັງບໍ່ມີແພັກເກດ — ກະລຸນາສ້າງ Package ກ່ອນທີ່ໜ້າ "ແພັກເກດ"
            </div>
          ) : (
            <Field label="ແພັກເກດ" required>
              <select value={packageId} onChange={e => setPackageId(e.target.value)} style={inputStyle}>
                {packages.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {fmtPrice(p.price, p.currency)}
                  </option>
                ))}
              </select>
              {selectedPkg && <PackagePreview pkg={selectedPkg} />}
            </Field>
          )}
          {ownerEmail ? (
            <div style={{ marginBottom: 16, padding: "10px 14px", background: "var(--surf2)", borderRadius: 8, fontSize: 13, color: "var(--text-2)", border: "1.5px solid var(--border)" }}>
              📧 Gmail: <strong style={{ color: "var(--text)" }}>{ownerEmail}</strong>
            </div>
          ) : (
            <Field label="ອີເມວ" required>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required style={inputStyle} placeholder="shop@example.com" />
            </Field>
          )}
          <Field label="ຊື່ຮ້ານ" required>
            <input type="text" value={shopName} onChange={e => setShopName(e.target.value)} required style={inputStyle} placeholder="ຊື່ຮ້ານຄ້າ" />
          </Field>
          <LaoAddressSelect
            province={province} district={district} village={village}
            onProvinceChange={setProvince} onDistrictChange={setDistrict} onVillageChange={setVillage}
          />

          {/* Feature toggles */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>ຟີເຈີ</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {([
                { key: "returnEnabled" as const,        label: "ຮັບຕີກັບສິນຄ້າ",      value: returnEnabled,        setter: setReturnEnabled },
                { key: "returnSummaryEnabled" as const,  label: "ສະຫຼຸບຍອດ",           value: returnSummaryEnabled,  setter: setReturnSummaryEnabled },
                { key: "monthlySummaryEnabled" as const, label: "ສະຫຼຸບປະຈຳເດືອນ",    value: monthlySummaryEnabled, setter: setMonthlySummaryEnabled },
                { key: "ledgerEnabled" as const,         label: "ບັນຊີລາຍຮັບລາຍຈ່າຍ / ສະຫຼຸບບັນຊີ", value: ledgerEnabled, setter: setLedgerEnabled },
              ]).map(f => (
                <label key={f.key} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 14px", borderRadius: 8,
                  border: `1.5px solid ${f.value ? "rgba(14,165,160,.35)" : "var(--border)"}`,
                  background: f.value ? "var(--accent-bg)" : "var(--surf2)",
                  cursor: "pointer", transition: "all .15s",
                }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: f.value ? "var(--accent)" : "var(--text-2)" }}>
                    {f.label}
                  </span>
                  <div
                    onClick={() => f.setter(!f.value)}
                    style={{
                      width: 40, height: 22, borderRadius: 11, position: "relative",
                      background: f.value ? "var(--accent)" : "var(--border)",
                      transition: "background .2s", cursor: "pointer", flexShrink: 0,
                    }}
                  >
                    <div style={{
                      position: "absolute", top: 3, left: f.value ? 21 : 3,
                      width: 16, height: 16, borderRadius: "50%", background: "#fff",
                      transition: "left .2s", boxShadow: "0 1px 3px rgba(0,0,0,.2)",
                    }}/>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {error && (
            <div style={{ padding: "10px 14px", marginBottom: 16, background: "var(--red-bg)", border: "1px solid rgba(239,68,68,.25)", borderRadius: 8, fontSize: 13, color: "var(--red)" }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button type="button" onClick={onClose} style={{ flex: 1, padding: "10px", border: "1.5px solid var(--border)", borderRadius: 8, background: "none", fontSize: 14, fontWeight: 500, color: "var(--text-2)", cursor: "pointer" }}>
              ຍົກເລີກ
            </button>
            <button type="submit" disabled={busy || packages.length === 0} style={{ flex: 1, padding: "10px", border: "none", borderRadius: 8, background: (busy || packages.length === 0) ? "var(--muted)" : "var(--accent)", fontSize: 14, fontWeight: 600, color: "#fff", cursor: (busy || packages.length === 0) ? "not-allowed" : "pointer" }}>
              {busy ? "ກຳລັງສ້າງ..." : "ສ້າງຮ້ານ"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Set Plan Modal ────────────────────────────────────────────────────

function SetPlanModal({ shop, packages, onClose, onUpdated }: {
  shop: ShopTenant;
  packages: Package[];
  onClose: () => void;
  onUpdated: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [packageId, setPackageId] = useState(packages[0]?.id ?? "");
  const [dateStr, setDateStr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedPkg = packages.find(p => p.id === packageId);
  const cfg = STATUS_CFG[shop.status] ?? STATUS_CFG.cancelled;

  useEffect(() => {
    if (selectedPkg) {
      const expiry = calcExpiry(selectedPkg.duration, selectedPkg.unit);
      setDateStr(expiry ? expiry.toISOString().slice(0, 10) : "");
    }
  }, [packageId]);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPkg) return;
    setError(""); setBusy(true);
    try {
      const plan = unitToPlan(selectedPkg.unit);
      const batch = writeBatch(db);
      batch.update(doc(db, "tenants", shop.id), {
        plan, duration: selectedPkg.duration, packageId: selectedPkg.id,
        status: "active",
        ...(selectedPkg.unit === "unlimited"
          ? { expiresAt: null }
          : { expiresAt: Timestamp.fromDate(new Date(dateStr + "T23:59:59")) }),
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, "shops", shop.id), {
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      onUpdated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "ເກີດຂໍ້ຜິດພາດ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={overlayRef} onClick={handleOverlayClick} style={{
      position: "fixed", inset: 0, background: "rgba(10,22,40,.6)",
      backdropFilter: "blur(3px)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 200, padding: 20,
    }}>
      <div style={{
        background: "var(--surf)", borderRadius: 14, width: "100%", maxWidth: 420,
        boxShadow: "0 20px 60px rgba(0,0,0,.2)", overflow: "hidden",
      }}>
        <div style={{
          padding: "20px 24px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>ຕັ້ງຄ່າແພັກເກດ</div>
            <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
              {shop.shopName}
              <span style={{
                fontSize: 11, fontWeight: 600, color: cfg.color, background: cfg.bg,
                border: `1px solid ${cfg.color}30`, borderRadius: 20, padding: "1px 8px",
              }}>{cfg.label}</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", padding: 4, borderRadius: 6, cursor: "pointer" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: "24px" }}>
          <Field label="ແພັກເກດ" required>
            <select value={packageId} onChange={e => setPackageId(e.target.value)} style={inputStyle}>
              {packages.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} — {fmtPrice(p.price, p.currency)}
                </option>
              ))}
            </select>
            {selectedPkg && <PackagePreview pkg={selectedPkg} />}
          </Field>
          {selectedPkg?.unit !== "unlimited" && (
            <Field label="ໝົດອາຍຸ">
              <input type="date" value={dateStr} onChange={e => setDateStr(e.target.value)} required style={inputStyle} />
            </Field>
          )}
          {selectedPkg?.unit === "unlimited" && (
            <div style={{ padding: "10px 14px", marginBottom: 16, background: "rgba(16,185,129,.08)", border: "1px solid rgba(16,185,129,.3)", borderRadius: 8, fontSize: 13, color: "var(--green)", fontWeight: 500 }}>
              ♾ ແພັກເກດນີ້ບໍ່ມີວັນໝົດອາຍຸ
            </div>
          )}

          {error && (
            <div style={{ padding: "10px 14px", marginBottom: 16, background: "var(--red-bg)", border: "1px solid rgba(239,68,68,.25)", borderRadius: 8, fontSize: 13, color: "var(--red)" }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button type="button" onClick={onClose} style={{ flex: 1, padding: "10px", border: "1.5px solid var(--border)", borderRadius: 8, background: "none", fontSize: 14, fontWeight: 500, color: "var(--text-2)", cursor: "pointer" }}>
              ຍົກເລີກ
            </button>
            <button type="submit" disabled={busy} style={{ flex: 1, padding: "10px", border: "none", borderRadius: 8, background: busy ? "var(--muted)" : "var(--accent)", fontSize: 14, fontWeight: 600, color: "#fff", cursor: busy ? "not-allowed" : "pointer" }}>
              {busy ? "ກຳລັງບັນທຶກ..." : "ຕັ້ງຄ່າ"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Edit Shop Modal ───────────────────────────────────────────────────

function EditShopModal({ shop, onClose, onSaved }: {
  shop: ShopTenant;
  onClose: () => void;
  onSaved: (updated: ShopTenant) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"info" | "settings">("info");
  const [shopName, setShopName] = useState(shop.shopName);
  const [status, setStatus] = useState<ShopTenant["status"]>(shop.status);
  const [province, setProvince] = useState("");
  const [district, setDistrict] = useState("");
  const [village, setVillage] = useState("");
  const [returnEnabled, setReturnEnabled] = useState(false);
  const [returnSummaryEnabled, setReturnSummaryEnabled] = useState(false);
  const [monthlySummaryEnabled, setMonthlySummaryEnabled] = useState(false);
  const [ledgerEnabled, setLedgerEnabled] = useState(false);
  const [vatPercent, setVatPercent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getDoc(doc(db, "shops", shop.id)).then(snap => {
      const d = snap.data();
      if (!d) return;
      setProvince(d.province ?? "");
      setDistrict(d.district ?? "");
      setVillage(d.village ?? "");
      setReturnEnabled(d.features?.returnEnabled ?? false);
      setReturnSummaryEnabled(d.features?.returnSummaryEnabled ?? false);
      setMonthlySummaryEnabled(d.features?.monthlySummaryEnabled ?? false);
      setLedgerEnabled(d.features?.ledgerEnabled ?? false);
      setVatPercent(d.vatPercent != null ? String(d.vatPercent) : "");
    }).catch(() => {});
  }, [shop.id]);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const features = { returnEnabled, returnSummaryEnabled, monthlySummaryEnabled, ledgerEnabled };
      const vatPercentNum = Math.min(100, Math.max(0, parseFloat(vatPercent) || 0));
      const batch = writeBatch(db);
      batch.update(doc(db, "tenants", shop.id), { shopName: shopName.trim(), status, updatedAt: serverTimestamp() });
      batch.update(doc(db, "shops", shop.id), { name: shopName.trim(), village: village.trim(), district: district.trim(), province: province.trim(), features, vatPercent: vatPercentNum, updatedAt: serverTimestamp() });
      await batch.commit();
      onSaved({ ...shop, shopName: shopName.trim(), status });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "ເກີດຂໍ້ຜິດພາດ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={overlayRef} onClick={handleOverlayClick} style={{
      position: "fixed", inset: 0, background: "rgba(10,22,40,.6)",
      backdropFilter: "blur(3px)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 200, padding: 20,
    }}>
      <div style={{
        background: "var(--surf)", borderRadius: 14, width: "100%", maxWidth: 420,
        boxShadow: "0 20px 60px rgba(0,0,0,.2)", overflow: "hidden",
      }}>
        <div style={{
          padding: "20px 24px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>ແກ້ໄຂຮ້ານ</div>
            <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 2 }}>{shop.shopName}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", padding: 4, borderRadius: 6, cursor: "pointer" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div style={{ display: "flex", gap: 4, padding: "16px 24px 0" }}>
          {([
            { key: "info" as const, label: "ຂໍ້ມູນຮ້ານ" },
            { key: "settings" as const, label: "ຕັ້ງຄ່າ" },
          ]).map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              style={{
                padding: "8px 16px", borderRadius: "8px 8px 0 0", border: "none",
                borderBottom: `2px solid ${tab === t.key ? "var(--accent)" : "transparent"}`,
                background: "none",
                color: tab === t.key ? "var(--accent)" : "var(--text-2)",
                fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} style={{ padding: "24px", overflowY: "auto", maxHeight: "calc(90vh - 80px)" }}>
          {tab === "info" ? (
            <>
              <Field label="ຊື່ຮ້ານ" required>
                <input type="text" value={shopName} onChange={e => setShopName(e.target.value)} required style={inputStyle} />
              </Field>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  ອີເມວ
                </div>
                <div style={{
                  ...inputStyle,
                  background: "var(--surf2)",
                  color: "var(--muted)",
                  userSelect: "all",
                  cursor: "default",
                }}>
                  {shop.ownerEmail}
                </div>
                <div style={{ marginTop: 5, fontSize: 11, color: "var(--muted)" }}>
                  ອີເມວຂອງ user ນີ້ — ແກ້ໄຂໄດ້ຜ່ານໜ້າ ລູກຄ້າ
                </div>
              </div>
              <LaoAddressSelect
                province={province} district={district} village={village}
                onProvinceChange={setProvince} onDistrictChange={setDistrict} onVillageChange={setVillage}
              />
              <Field label="VAT (%)">
                <input
                  type="number" min="0" max="100" step="0.1"
                  value={vatPercent} onChange={e => setVatPercent(e.target.value)}
                  placeholder="0" style={inputStyle}
                />
              </Field>
              <Field label="ສະຖານະ">
                <select value={status} onChange={e => setStatus(e.target.value as ShopTenant["status"])} style={inputStyle}>
                  <option value="active">ໃຊ້ງານ</option>
                  <option value="trial">ທົດລອງໃຊ້</option>
                  <option value="suspended">ລະງັບ</option>
                  <option value="cancelled">ຍົກເລີກ</option>
                </select>
              </Field>
            </>
          ) : (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>ຟີເຈີ</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {([
                  { key: "returnEnabled" as const,        label: "ຮັບຕີກັບສິນຄ້າ",   value: returnEnabled,        setter: setReturnEnabled },
                  { key: "returnSummaryEnabled" as const,  label: "ສະຫຼຸບຍອດ",        value: returnSummaryEnabled,  setter: setReturnSummaryEnabled },
                  { key: "monthlySummaryEnabled" as const, label: "ສະຫຼຸບປະຈຳເດືອນ", value: monthlySummaryEnabled, setter: setMonthlySummaryEnabled },
                  { key: "ledgerEnabled" as const,         label: "ບັນຊີລາຍຮັບລາຍຈ່າຍ / ສະຫຼຸບບັນຊີ", value: ledgerEnabled, setter: setLedgerEnabled },
                ]).map(f => (
                  <label key={f.key} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 14px", borderRadius: 8,
                    border: `1.5px solid ${f.value ? "rgba(14,165,160,.35)" : "var(--border)"}`,
                    background: f.value ? "var(--accent-bg)" : "var(--surf2)",
                    cursor: "pointer",
                  }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: f.value ? "var(--accent)" : "var(--text-2)" }}>
                      {f.label}
                    </span>
                    <div onClick={() => f.setter(!f.value)} style={{
                      width: 40, height: 22, borderRadius: 11, position: "relative",
                      background: f.value ? "var(--accent)" : "var(--border)",
                      transition: "background .2s", cursor: "pointer", flexShrink: 0,
                    }}>
                      <div style={{
                        position: "absolute", top: 3, left: f.value ? 21 : 3,
                        width: 16, height: 16, borderRadius: "50%", background: "#fff",
                        transition: "left .2s", boxShadow: "0 1px 3px rgba(0,0,0,.2)",
                      }}/>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div style={{ padding: "10px 14px", marginBottom: 16, background: "var(--red-bg)", border: "1px solid rgba(239,68,68,.25)", borderRadius: 8, fontSize: 13, color: "var(--red)" }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={onClose} style={{ flex: 1, padding: "10px", border: "1.5px solid var(--border)", borderRadius: 8, background: "none", fontSize: 14, fontWeight: 500, color: "var(--text-2)", cursor: "pointer" }}>
              ຍົກເລີກ
            </button>
            <button type="submit" disabled={busy} style={{ flex: 1, padding: "10px", border: "none", borderRadius: 8, background: busy ? "var(--muted)" : "var(--accent)", fontSize: 14, fontWeight: 600, color: "#fff", cursor: busy ? "not-allowed" : "pointer" }}>
              {busy ? "ກຳລັງບັນທຶກ..." : "ບັນທຶກ"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Add Payment Modal ─────────────────────────────────────────────────

function AddPaymentModal({ customerId, shops, packages, onClose, onCreated }: {
  customerId: string;
  shops: ShopTenant[];
  packages: Package[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [packageId, setPackageId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "transfer">("transfer");
  const [note, setNote] = useState("");
  const [slipFile, setSlipFile] = useState<File | null>(null);
  const [slipPreview, setSlipPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedShop = shops.find(s => s.id === shopId);
  const selectedPkg = packages.find(p => p.id === packageId);

  useEffect(() => {
    if (selectedPkg) setAmount(String(selectedPkg.price));
  }, [packageId]);

  function handleSlipChange(file: File | null) {
    setSlipFile(file);
    if (slipPreview) URL.revokeObjectURL(slipPreview);
    setSlipPreview(file ? URL.createObjectURL(file) : "");
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amountNum = parseFloat(amount.replace(/,/g, ""));
    if (isNaN(amountNum) || amountNum < 0) { setError("ກະລຸນາປ້ອນຈຳນວນທີ່ຖືກຕ້ອງ"); return; }
    setError(""); setBusy(true);
    try {
      let slipUrl: string | null = null;
      if (method === "transfer" && slipFile) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(slipFile);
        });
        const base64 = dataUrl.split(",")[1];
        const form = new FormData();
        form.append("key", import.meta.env.VITE_IMGBB_API_KEY);
        form.append("image", base64);
        const res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: form });
        const json = await res.json();
        if (!json.success) throw new Error("ອັບໂຫລດສະລີບບໍ່ສຳເລັດ");
        slipUrl = json.data.display_url as string;
      }
      await addDoc(collection(db, "customers", customerId, "payments"), {
        shopId,
        shopName: selectedShop?.shopName ?? "",
        packageId: packageId || null,
        packageName: selectedPkg?.name ?? null,
        amount: amountNum,
        method,
        slipUrl,
        paidAt: Timestamp.fromDate(new Date()),
        note: note.trim(),
        createdAt: serverTimestamp(),
      });

      if (selectedPkg) {
        const tenantSnap = await getDoc(doc(db, "tenants", shopId));
        const currentExpiresAt = tenantSnap.data()?.expiresAt?.toDate?.() as Date | undefined;
        const base = currentExpiresAt && currentExpiresAt > new Date() ? currentExpiresAt : new Date();
        const newExpiry = new Date(base);
        if (selectedPkg.unit === "month") newExpiry.setMonth(newExpiry.getMonth() + selectedPkg.duration);
        else if (selectedPkg.unit === "year") newExpiry.setFullYear(newExpiry.getFullYear() + selectedPkg.duration);
        else newExpiry.setDate(newExpiry.getDate() + selectedPkg.duration);
        await updateDoc(doc(db, "tenants", shopId), {
          status: "active",
          plan: unitToPlan(selectedPkg.unit),
          duration: selectedPkg.duration,
          packageId: selectedPkg.id,
          expiresAt: Timestamp.fromDate(newExpiry),
          updatedAt: serverTimestamp(),
        });
      }

      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "ເກີດຂໍ້ຜິດພາດ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={overlayRef} onClick={handleOverlayClick} style={{
      position: "fixed", inset: 0, background: "rgba(10,22,40,.6)",
      backdropFilter: "blur(3px)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 200, padding: 20,
    }}>
      <div style={{
        background: "var(--surf)", borderRadius: 14, width: "100%", maxWidth: 460,
        boxShadow: "0 20px 60px rgba(0,0,0,.2)", overflow: "hidden",
        maxHeight: "90vh", display: "flex", flexDirection: "column",
      }}>
        <div style={{
          padding: "20px 24px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>ບັນທຶກການຊຳລະ</div>
            <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 2 }}>ບັນທຶກຄ່າ subscription ທີ່ໄດ້ຮັບ</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", padding: 4, borderRadius: 6, cursor: "pointer" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: "24px", overflowY: "auto" }}>
          <Field label="ຮ້ານ" required>
            <select value={shopId} onChange={e => setShopId(e.target.value)} style={inputStyle}>
              {shops.map(s => <option key={s.id} value={s.id}>{s.shopName}</option>)}
            </select>
          </Field>

          {packages.length > 0 && (
            <Field label="ແພັກເກດ (ທາງເລືອກ)">
              <select value={packageId} onChange={e => setPackageId(e.target.value)} style={inputStyle}>
                <option value="">— ເລືອກແພັກເກດ —</option>
                {packages.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {fmtPrice(p.price, p.currency)}
                  </option>
                ))}
              </select>
              {selectedPkg && <PackagePreview pkg={selectedPkg} />}
            </Field>
          )}

          <Field label="ຈຳນວນ (₭)" required>
            <input
              type="number" min="0" step="1000"
              value={amount} onChange={e => setAmount(e.target.value)}
              required style={inputStyle} placeholder="30,000"
            />
          </Field>

          <Field label="ວິທີຊຳລະ">
            <div style={{ display: "flex", gap: 8 }}>
              {(["transfer", "cash"] as const).map(m => (
                <button key={m} type="button" onClick={() => setMethod(m)} style={{
                  flex: 1, padding: "9px 0", borderRadius: 8, fontSize: 14, fontWeight: 600,
                  border: `2px solid ${method === m ? (m === "transfer" ? "var(--blue, #3b82f6)" : "#10b981") : "var(--border)"}`,
                  background: method === m ? (m === "transfer" ? "var(--blue-bg)" : "var(--green-bg)") : "var(--surf2)",
                  color: method === m ? (m === "transfer" ? "var(--blue)" : "#10b981") : "var(--text-2)",
                  cursor: "pointer", transition: "all .15s",
                }}>
                  {m === "transfer" ? "💳 ໂອນ" : "💵 ສົດ"}
                </button>
              ))}
            </div>
          </Field>

          {method === "transfer" && (
            <Field label="ສະລີບໂອນ">
              <input
                type="file"
                accept="image/*"
                onChange={e => handleSlipChange(e.target.files?.[0] ?? null)}
                style={{ ...inputStyle, padding: "7px 13px", cursor: "pointer" }}
              />
              {slipPreview && (
                <img
                  src={slipPreview}
                  alt="slip preview"
                  style={{ marginTop: 8, width: "100%", maxHeight: 200, objectFit: "contain", borderRadius: 8, border: "1px solid var(--border)" }}
                />
              )}
            </Field>
          )}

          <Field label="ໝາຍເຫດ">
            <input type="text" value={note} onChange={e => setNote(e.target.value)} style={inputStyle} placeholder="ທາງເລືອກ..." />
          </Field>

          {error && (
            <div style={{ padding: "10px 14px", marginBottom: 16, background: "var(--red-bg)", border: "1px solid rgba(239,68,68,.25)", borderRadius: 8, fontSize: 13, color: "var(--red)" }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button type="button" onClick={onClose} style={{ flex: 1, padding: "10px", border: "1.5px solid var(--border)", borderRadius: 8, background: "none", fontSize: 14, fontWeight: 500, color: "var(--text-2)", cursor: "pointer" }}>
              ຍົກເລີກ
            </button>
            <button type="submit" disabled={busy} style={{ flex: 1, padding: "10px", border: "none", borderRadius: 8, background: busy ? "var(--muted)" : "#10b981", fontSize: 14, fontWeight: 600, color: "#fff", cursor: busy ? "not-allowed" : "pointer" }}>
              {busy ? "ກຳລັງບັນທຶກ..." : "ບັນທຶກ"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 13px",
  border: "1.5px solid var(--border)", borderRadius: 8,
  fontSize: 14, color: "var(--text)", background: "var(--surf)", outline: "none",
};

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
        {label}{required && <span style={{ color: "var(--red)", marginLeft: 3 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

// ─── Edit Payment Modal ────────────────────────────────────────────────

function EditPaymentModal({ customerId, payment, shops, packages, onClose, onSaved }: {
  customerId: string;
  payment: Payment;
  shops: ShopTenant[];
  packages: Package[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [shopId, setShopId] = useState(payment.shopId);
  const [packageId, setPackageId] = useState(payment.packageId ?? "");
  const [amount, setAmount] = useState(String(payment.amount));
  const [method, setMethod] = useState<"cash" | "transfer">(payment.method);
  const [note, setNote] = useState(payment.note);
  const [slipFile, setSlipFile] = useState<File | null>(null);
  const [slipPreview, setSlipPreview] = useState(payment.slipUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedShop = shops.find(s => s.id === shopId);
  const selectedPkg = packages.find(p => p.id === packageId);

  function handleSlipChange(file: File | null) {
    setSlipFile(file);
    if (file) setSlipPreview(URL.createObjectURL(file));
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amountNum = parseFloat(amount.replace(/,/g, ""));
    if (isNaN(amountNum) || amountNum < 0) { setError("ກະລຸນາປ້ອນຈຳນວນທີ່ຖືກຕ້ອງ"); return; }
    setError(""); setBusy(true);
    try {
      let slipUrl: string | null = payment.slipUrl;
      if (method === "transfer" && slipFile) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(slipFile);
        });
        const base64 = dataUrl.split(",")[1];
        const form = new FormData();
        form.append("key", import.meta.env.VITE_IMGBB_API_KEY);
        form.append("image", base64);
        const res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: form });
        const json = await res.json();
        if (!json.success) throw new Error("ອັບໂຫລດສະລີບບໍ່ສຳເລັດ");
        slipUrl = json.data.display_url as string;
      }
      if (method === "cash") slipUrl = null;
      await updateDoc(doc(db, "customers", customerId, "payments", payment.id), {
        shopId,
        shopName: selectedShop?.shopName ?? payment.shopName,
        packageId: packageId || null,
        packageName: selectedPkg?.name ?? null,
        amount: amountNum,
        method,
        slipUrl,
        note: note.trim(),
      });
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "ເກີດຂໍ້ຜິດພາດ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={overlayRef} onClick={handleOverlayClick} style={{
      position: "fixed", inset: 0, background: "rgba(10,22,40,.6)",
      backdropFilter: "blur(3px)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 200, padding: 20,
    }}>
      <div style={{
        background: "var(--surf)", borderRadius: 14, width: "100%", maxWidth: 460,
        boxShadow: "0 20px 60px rgba(0,0,0,.2)", overflow: "hidden",
        maxHeight: "90vh", display: "flex", flexDirection: "column",
      }}>
        <div style={{
          padding: "20px 24px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>ແກ້ໄຂການຊຳລະ</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", padding: 4, borderRadius: 6, cursor: "pointer" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: "24px", overflowY: "auto" }}>
          <Field label="ຮ້ານ" required>
            <select value={shopId} onChange={e => setShopId(e.target.value)} style={inputStyle}>
              {shops.map(s => <option key={s.id} value={s.id}>{s.shopName}</option>)}
            </select>
          </Field>

          {packages.length > 0 && (
            <Field label="ແພັກເກດ (ທາງເລືອກ)">
              <select value={packageId} onChange={e => setPackageId(e.target.value)} style={inputStyle}>
                <option value="">— ເລືອກແພັກເກດ —</option>
                {packages.map(p => (
                  <option key={p.id} value={p.id}>{p.name} — {fmtPrice(p.price, p.currency)}</option>
                ))}
              </select>
              {selectedPkg && <PackagePreview pkg={selectedPkg} />}
            </Field>
          )}

          <Field label="ຈຳນວນ (₭)" required>
            <input type="number" min="0" step="1000" value={amount} onChange={e => setAmount(e.target.value)} required style={inputStyle} />
          </Field>

          <Field label="ວິທີຊຳລະ">
            <div style={{ display: "flex", gap: 8 }}>
              {(["transfer", "cash"] as const).map(m => (
                <button key={m} type="button" onClick={() => setMethod(m)} style={{
                  flex: 1, padding: "9px 0", borderRadius: 8, fontSize: 14, fontWeight: 600,
                  border: `2px solid ${method === m ? (m === "transfer" ? "var(--blue, #3b82f6)" : "#10b981") : "var(--border)"}`,
                  background: method === m ? (m === "transfer" ? "var(--blue-bg)" : "var(--green-bg)") : "var(--surf2)",
                  color: method === m ? (m === "transfer" ? "var(--blue)" : "#10b981") : "var(--text-2)",
                  cursor: "pointer",
                }}>
                  {m === "transfer" ? "💳 ໂອນ" : "💵 ສົດ"}
                </button>
              ))}
            </div>
          </Field>

          {method === "transfer" && (
            <Field label="ສະລີບໂອນ">
              <input type="file" accept="image/*" onChange={e => handleSlipChange(e.target.files?.[0] ?? null)}
                style={{ ...inputStyle, padding: "7px 13px", cursor: "pointer" }} />
              {slipPreview && (
                <img src={slipPreview} alt="slip" style={{ marginTop: 8, width: "100%", maxHeight: 200, objectFit: "contain", borderRadius: 8, border: "1px solid var(--border)" }} />
              )}
            </Field>
          )}

          <Field label="ໝາຍເຫດ">
            <input type="text" value={note} onChange={e => setNote(e.target.value)} style={inputStyle} placeholder="ທາງເລືອກ..." />
          </Field>

          {error && (
            <div style={{ padding: "10px 14px", marginBottom: 16, background: "var(--red-bg)", border: "1px solid rgba(239,68,68,.25)", borderRadius: 8, fontSize: 13, color: "var(--red)" }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button type="button" onClick={onClose} style={{ flex: 1, padding: "10px", border: "1.5px solid var(--border)", borderRadius: 8, background: "none", fontSize: 14, fontWeight: 500, color: "var(--text-2)", cursor: "pointer" }}>
              ຍົກເລີກ
            </button>
            <button type="submit" disabled={busy} style={{ flex: 1, padding: "10px", border: "none", borderRadius: 8, background: busy ? "var(--muted)" : "var(--accent)", fontSize: 14, fontWeight: 600, color: "#fff", cursor: busy ? "not-allowed" : "pointer" }}>
              {busy ? "ກຳລັງບັນທຶກ..." : "ບັນທຶກ"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Confirm Delete Payment Modal ──────────────────────────────────────

// ─── Confirm Suspend/Unsuspend Modal ──────────────────────────────────

function ConfirmSuspendModal({ shop, onClose, onConfirm }: {
  shop: ShopTenant;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isSuspended = shop.status === "suspended";
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(10,22,40,.6)",
      backdropFilter: "blur(3px)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 200, padding: 20,
    }}>
      <div style={{
        background: "var(--surf)", borderRadius: 14, width: "100%", maxWidth: 380,
        boxShadow: "0 20px 60px rgba(0,0,0,.2)", padding: 28, textAlign: "center",
      }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>{isSuspended ? "✅" : "🚫"}</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
          {isSuspended ? "ເປີດໃຊ້ງານໃໝ່?" : "ລະງັບການໃຊ້ງານ?"}
        </div>
        <div style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 24 }}>
          ຮ້ານ <strong>{shop.shopName}</strong> ຈະ{isSuspended ? "ສາມາດໃຊ້ງານໄດ້ຄືນ" : "ຖືກລະງັບ ລູກຄ້າຈະເຂົ້າລະບົບບໍ່ໄດ້"}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px", border: "1.5px solid var(--border)", borderRadius: 8, background: "none", fontSize: 14, fontWeight: 500, color: "var(--text-2)", cursor: "pointer" }}>
            ຍົກເລີກ
          </button>
          <button onClick={onConfirm} style={{ flex: 1, padding: "10px", border: "none", borderRadius: 8, background: isSuspended ? "#10b981" : "var(--red)", fontSize: 14, fontWeight: 600, color: "#fff", cursor: "pointer" }}>
            {isSuspended ? "ເປີດໃໝ່" : "ລະງັບ"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Confirm Delete Payment Modal ──────────────────────────────────────

function ConfirmDeletePaymentModal({ customerId, paymentId, onClose, onDeleted }: {
  customerId: string;
  paymentId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    setBusy(true);
    try {
      await deleteDoc(doc(db, "customers", customerId, "payments", paymentId));
      onDeleted();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(10,22,40,.6)",
      backdropFilter: "blur(3px)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 200, padding: 20,
    }}>
      <div style={{
        background: "var(--surf)", borderRadius: 14, width: "100%", maxWidth: 380,
        boxShadow: "0 20px 60px rgba(0,0,0,.2)", padding: 28, textAlign: "center",
      }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🗑️</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>ລົບການຊຳລະ?</div>
        <div style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 24 }}>ຂໍ້ມູນຈະຖືກລົບຖາວອນ ບໍ່ສາມາດກູ້ຄືນໄດ້</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} disabled={busy} style={{ flex: 1, padding: "10px", border: "1.5px solid var(--border)", borderRadius: 8, background: "none", fontSize: 14, fontWeight: 500, color: "var(--text-2)", cursor: "pointer" }}>
            ຍົກເລີກ
          </button>
          <button onClick={handleDelete} disabled={busy} style={{ flex: 1, padding: "10px", border: "none", borderRadius: 8, background: busy ? "var(--muted)" : "var(--red)", fontSize: 14, fontWeight: 600, color: "#fff", cursor: busy ? "not-allowed" : "pointer" }}>
            {busy ? "ກຳລັງລົບ..." : "ລົບ"}
          </button>
        </div>
      </div>
    </div>
  );
}
