import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";

const summary = [
  { label: "Активные поставки", value: "7", hint: "2 требуют внимания" },
  { label: "Товар в пути", value: "68,4 т", hint: "4 автомобиля" },
  { label: "Ближайшая поставка", value: "29 сен", hint: "RVI · Leib7-x" },
  { label: "Задачи на сегодня", value: "11", hint: "3 просрочены" },
];

const projects = [
  { code: "Leib7-x", client: "RVI", route: "Финляндия → Казахстан", stage: "Таможня", tone: "warning" },
  { code: "HS-41", client: "Маркет Групп", route: "Польша → Казахстан", stage: "В пути", tone: "info" },
  { code: "KV-02", client: "ИП Кишик", route: "Казахстан → Россия", stage: "Закрытие", tone: "success" },
];

const tasks = [
  ["Проверить инвойс Leib7-x", "Сегодня, 14:00", "Рафия"],
  ["Согласовать тираж стикеров", "Сегодня, 17:00", "Логистика"],
  ["Получить CMR от перевозчика", "27 сентября", "Перевозчик"],
];

export default async function Home() {
  const { profile, roles } = await requireUser();
  const fullName = profile.full_name;
  const firstName = fullName.split(/\s+/)[0];
  const currentDate = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Asia/Qyzylorda",
  }).format(new Date());

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="overview" />

      <section className="workspace" id="overview">
        <header className="topbar">
          <div><p className="eyebrow">{currentDate}</p><h1>Добрый день, {firstName}</h1></div>
          <div className="top-actions"><button className="ghost" type="button">Поиск</button><button className="primary" type="button">+ Новая поставка</button></div>
        </header>

        <section className="summary-grid" aria-label="Сводка">
          {summary.map((item) => <article className="summary-card" key={item.label}><p>{item.label}</p><strong>{item.value}</strong><small>{item.hint}</small></article>)}
        </section>

        <section className="content-grid" id="workspace">
          <article className="panel projects-panel">
            <div className="panel-heading"><div><p className="eyebrow">Операционный контур</p><h2>Поставки в работе</h2></div><button className="text-button" type="button">Все поставки →</button></div>
            <div className="project-list">
              {projects.map((project) => (
                <div className="project-row" key={project.code}>
                  <div className="project-code">{project.code}</div>
                  <div><strong>{project.client}</strong><small>{project.route}</small></div>
                  <span className={`status ${project.tone}`}>{project.stage}</span>
                  <span className="arrow" aria-hidden="true">→</span>
                </div>
              ))}
            </div>
          </article>

          <article className="panel alert-panel">
            <p className="eyebrow">Контроль</p><h2>Требует внимания</h2>
            <div className="alert"><strong>3 документа</strong><span>не прошли проверку</span></div>
            <div className="alert"><strong>2 партии</strong><span>ОСГ ниже 60%</span></div>
            <div className="alert"><strong>1 поставка</strong><span>отклонение от срока</span></div>
          </article>

          <article className="panel tasks-panel">
            <div className="panel-heading"><div><p className="eyebrow">Сегодня</p><h2>Ближайшие задачи</h2></div><button className="text-button" type="button">Открыть задачи →</button></div>
            {tasks.map(([title, time, owner]) => <div className="task" key={title}><span className="check"/><div><strong>{title}</strong><small>{owner}</small></div><time>{time}</time></div>)}
          </article>
        </section>
      </section>
    </main>
  );
}
