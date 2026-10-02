/* Case study carousels: arrows, dots, swipe (scroll-snap). */
document.querySelectorAll('.pcar').forEach(function(c){
  var t=c.querySelector('.pcar-track'),imgs=t.querySelectorAll('img'),b=c.querySelectorAll('.pcar-btn'),d=c.querySelector('.pcar-dots'),dots=[];
  function step(){return imgs[0].getBoundingClientRect().width+16}
  function cur(){return Math.round(t.scrollLeft/step())}
  function last(){return t.scrollLeft+t.clientWidth>=t.scrollWidth-2}
  imgs.forEach(function(_,i){var x=document.createElement('button');x.type='button';x.className='pcar-dot';x.setAttribute('aria-label','Screenshot '+(i+1));
    x.addEventListener('click',function(){t.scrollTo({left:i*step()})});d.appendChild(x);dots.push(x)});
  function upd(){var i=last()?imgs.length-1:cur();dots.forEach(function(x,k){x.classList.toggle('on',k===i)});
    b[0].disabled=t.scrollLeft<=2;b[1].disabled=last();c.classList.toggle('fits',t.scrollWidth<=t.clientWidth+2)}
  b.forEach(function(x){x.addEventListener('click',function(){t.scrollBy({left:step()*+x.dataset.dir})})});
  t.addEventListener('scroll',upd,{passive:true});imgs.forEach(function(i){i.addEventListener('load',upd)});
  window.addEventListener('resize',upd);upd();
});
