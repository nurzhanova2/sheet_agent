# Product UX

Product UX находится в Task Pane и делает границу между чтением, анализом и изменением видимой.

Основные блоки:

- Quick Actions для текущего selection;
- Activity Timeline со статусом каждого tool/run шага;
- Change Preview с risk level и отдельными Approve/Reject controls;
- Recent Changes с Undo;
- Recent Sessions;
- Settings с privacy consent indicator.

`ProductUXPanel` не вызывает Excel API. Он получает data/callbacks через props, поэтому approve/reject/undo подключаются к runtime и ChangeSet service без обхода application boundary.

UI придерживается `emil-design-eng`: кнопки имеют press feedback, анимации ограничены функциональной обратной связью, `transition: all` и `ease-in` не используются, а reduced-motion отключает transform transitions.
