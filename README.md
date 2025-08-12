# Учет зарплат (Payroll Manager)

Адаптивное веб‑приложение для учета зарплат сотрудников: начисления и удержания, авто‑конвертация UAH/EUR/USD по актуальным курсам (кэш 1ч), локальное сохранение (LocalStorage), импорт/экспорт JSON, чат с OpenRouter, тёмная/светлая/auto темы, мобильная оптимизация.

## Запуск локально

```bash
python3 -m http.server 5173
# Откройте: http://localhost:5173
```

## Настройки
- Базовая валюта для курсов и тема — в «Настройки».
- Для чата добавьте API‑ключ OpenRouter в «Настройки». Ключ хранится локально.

## Данные
- Экспорт/импорт JSON — «Настройки → Данные».
- «Очистить всё» — удаляет локальные данные.

---

English (short): Adaptive payroll tracker with accruals/deductions, live FX (UAH/EUR/USD), local save, OpenRouter chat, dark mode, mobile‑friendly. Run with `python3 -m http.server 5173` and open `http://localhost:5173`.
