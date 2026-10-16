await go('#/ai');
const form = document.querySelector('#chat-form');
form.querySelector('textarea').value = '链接和关键词索引有什么区别？各自什么时候用？';
form.requestSubmit();
