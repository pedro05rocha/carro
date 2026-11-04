# Integração e validação no LIMO

## Compatibilidade de rosbridge

A indexação oficial do ROS lista pacotes rosbridge_suite/rosbridge_server para Foxy. Foxy já terminou o suporte upstream. Fixar a distribuição e testar no robô é necessário, sobretudo porque `limo_msgs` é uma interface específica do fabricante.

## Câmara DaBai DC1

Apenas `/dev/video0` foi confirmado. Isso pode corresponder a dispositivo V4L2 sem nó ROS. Confirme no sistema LIMO qual driver Orbbec está instalado e execute `ros2 topic list -t`; verifique se imagem e/ou depth são efetivamente publicados. Não se presume `/camera/image_raw` nem qualquer nome. A primeira versão mantém a imagem como indisponível.

## Checklist de ensaio controlado

- Verificar tópicos e tipo de mensagem no robô; comparar com os nomes e interfaces configurados na aplicação.
- Ligar pelo IP privado, interromper e restaurar bridge, e confirmar estados.
- Confirmar que scan, imu, odom e status chegam sem valores inventados.
- Com rodas suspensas/área segura e E-stop físico acessível, testar comando de velocidade reduzida, libertação do botão, expiração da lease, desconexão de rede e paragem de emergência.
- Verificar no robô por `ros2 topic echo /cmd_vel` os zeros enviados ao largar ou perder a lease.
- Só testar movimento no chão após validar limites, travagem e watchdog físico com responsável de segurança.
