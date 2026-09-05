(function(){
'use strict';

function digits(value){
  return String(value || '').replace(/\D/g, '').slice(0, 11);
}

function formatBrazilianPhone(value){
  const raw = digits(value);
  if(!raw) return '';
  if(raw.length <= 2) return '(' + raw;

  const ddd = raw.slice(0, 2);
  const number = raw.slice(2);
  if(number.length <= 4) return '(' + ddd + ') ' + number;

  const mobile = number.length > 8;
  const split = mobile ? 5 : 4;
  const first = number.slice(0, split);
  const second = number.slice(split);
  return '(' + ddd + ') ' + first + (second ? '-' + second : '');
}

function applyMask(input){
  if(!input) return;
  const update = () => {
    input.value = formatBrazilianPhone(input.value);
  };
  input.addEventListener('input', update);
  input.addEventListener('blur', update);
  update();
}

const phone = document.getElementById('phone');
applyMask(phone);

window.PortariaSyncPhoneMask = {
  digits,
  formatBrazilianPhone
};
})();
